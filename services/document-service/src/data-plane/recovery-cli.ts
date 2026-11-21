/**
 * The replay-and-verify tool and the new-incarnation procedure (06 §9, §11; BE-078, BE-081), for
 * operators. It needs the database and the object store, not a running service.
 *
 *   node src/data-plane/recovery-cli.ts rebuild --tenant T --doc D [--seq N]
 *       Prints the SHA-256 of the canonical document at N (default: the head); exit 0.
 *   node src/data-plane/recovery-cli.ts verify --tenant T --doc D
 *       Checks the hash chain, every payload against its hash (those in the log table and those
 *       that have moved to cold segments, HIS-029), and every recorded checkpoint against a
 *       replay; exit 1 naming the first broken `seq`.
 *   node src/data-plane/recovery-cli.ts incarnation [--dry-run]
 *       Lists the documents whose checkpoints reach past their head (dry run), or gives each a
 *       new incarnation and sets those checkpoints aside.
 *
 * Settings come from the environment as for the service (DOCEDIT_DATABASE_URL, DOCEDIT_S3_*).
 * Run as the schema owner (an operator role) for `incarnation`, which reads across tenants.
 */
import { configFromEnv } from '../config.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { S3ObjectStore } from '../objects/s3.ts';
import { ObjectColdPayloads } from '../storage/cold-payloads.ts';
import { createPool } from '../storage/db.ts';
import { PgGrantStore } from '../storage/grant-store.ts';
import { PgLogStore } from '../storage/log-store.ts';
import { PgAuditStore } from './pg/audit.ts';
import { PgCheckpointIndex } from './pg/checkpoint-index.ts';
import { affected, rebuild, runIncarnation, verifyCheckpoint } from './recovery.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const command = process.argv[2];
const config = configFromEnv();
if (!config.databaseUrl || !config.s3) {
  console.error('Set DOCEDIT_DATABASE_URL and the DOCEDIT_S3_* settings.');
  process.exit(2);
}
const pool = createPool({ connectionString: config.databaseUrl });
const grants = new PgGrantStore(pool);
const objects = new S3ObjectStore(config.s3);
// Payloads that have moved to cold segments are read from the object store (HIS-029): `rebuild`
// replays them, and `verify` checks each against the hash the chain covers.
const logs = new PgLogStore(pool, {
  permissions: (ref) => grants.current(ref),
  coldPayloads: new ObjectColdPayloads(objects),
});
const stores = {
  logs,
  checkpoints: new ObjectCheckpointStore(objects),
  index: new PgCheckpointIndex(pool),
  audit: new PgAuditStore(pool),
};

let code = 0;
try {
  if (command === 'rebuild' || command === 'verify') {
    const tenant = arg('tenant');
    const doc = arg('doc');
    if (!tenant || !doc) throw new Error('--tenant and --doc are required');
    const ref = { tenant, doc };
    if (command === 'rebuild') {
      const seq = arg('seq');
      const r = await rebuild(stores, ref, seq === undefined ? undefined : Number(seq));
      console.log(`${r.hash}  seq ${r.seq} (from checkpoint ${r.from}, ${r.replayed} commits)`);
    } else {
      const chain = await logs.verify(ref, { payloads: true });
      if (!chain.ok) {
        console.error(`broken at seq ${chain.seq}: ${chain.reason}`);
        code = 1;
      } else {
        console.log(`chain ok up to seq ${chain.head}`);
        for (const row of await stores.index.list(ref)) {
          const v = await verifyCheckpoint(stores, ref, row.seq);
          if (!v.ok) {
            console.error(`checkpoint ${v.seq} differs from the replay from ${v.from}`);
            code = 1;
            break;
          }
          console.log(`checkpoint ${v.seq} ok (${v.stored})`);
        }
      }
    }
  } else if (command === 'incarnation') {
    const list = await affected(pool);
    const dryRun = process.argv.includes('--dry-run');
    if (dryRun) {
      for (const a of list)
        console.log(`${a.tenant} ${a.doc}: head ${a.head}, checkpoint ${a.checkpoint}`);
      console.log(`${list.length} documents would get a new incarnation; nothing was changed`);
    }
    for (const r of await runIncarnation(stores, list, { dryRun }))
      console.log(
        `${r.ref.tenant} ${r.ref.doc}: incarnation ${r.after}, set aside ${r.setAside.join(', ') || 'none'}`,
      );
  } else {
    console.error('usage: recovery-cli.ts rebuild|verify|incarnation (see the file header)');
    code = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
