/**
 * BE-071: how fast one PostgreSQL primary takes commit-log inserts, as a command. From the
 * repository root, with the test environment up (`pwsh -NoProfile -File infra/test-env.ps1 up`):
 *
 *   node services/document-service/scripts/load/be-071.ts [--writers 1,2,4,8,16,32,64]
 *     [--seconds 5] [--batch 1] [--out report.json]
 *
 * It calls `PgLogStore.append` directly (no sockets, no room): each writer owns a document,
 * claims it, and appends commits back to back, each append being one transaction of `--batch`
 * commits (06 §2.3). A step ramps the number of writers; the report gives, per step, the commits
 * per second, the appends per second and the latency of an append. The rate at which more
 * writers stop adding commits is the plateau of that setup. It is a property of the machine and
 * the database settings the report lists, so a figure must be quoted with them.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createPool, PgDocumentStore, PgGrantStore, PgLogStore } from '../../src/index.ts';
import { initialPermissions, stepCommit, write } from '../../test/contract/checks.ts';
import { createTestDatabase, newTenant, postgresUnavailable } from '../../test/support/env.ts';

const { values } = parseArgs({
  options: {
    writers: { type: 'string', default: '1,2,4,8,16,32,64' },
    seconds: { type: 'string', default: '5' },
    batch: { type: 'string', default: '1' },
    out: { type: 'string' },
  },
});
const steps = values.writers!.split(',').map(Number);
const seconds = Number(values.seconds);
const batch = Number(values.batch);
if (![...steps, seconds, batch].every((n) => Number.isInteger(n) && n > 0)) {
  console.error('--writers, --seconds and --batch are positive whole numbers');
  process.exit(2);
}
const why = await postgresUnavailable();
if (why) {
  console.error(why);
  process.exit(2);
}

const db = await createTestDatabase();
const quantile = (sorted: number[], q: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;

try {
  // One connection per writer at most, so the pool is never the limit of a step.
  const poolSize = Math.max(...steps) + 4;
  const pool = createPool({ ...db.serviceConfig, max: poolSize });
  const grants = new PgGrantStore(pool);
  const logs = new PgLogStore(pool, { permissions: (ref) => grants.current(ref) });
  const docs = new PgDocumentStore(pool);
  const tenant = newTenant();

  const settingNames = [
    'server_version',
    'synchronous_commit',
    'fsync',
    'full_page_writes',
    'shared_buffers',
    'wal_level',
    'max_connections',
  ];
  const settings: Record<string, string> = {};
  for (const name of settingNames)
    settings[name] = (
      await db.admin.query<{ v: string }>(`SELECT current_setting('${name}') AS v`)
    ).rows[0]!.v;

  const report = [];
  for (const writers of steps) {
    const refs = await Promise.all(
      Array.from({ length: writers }, async () => {
        const rec = await docs.create(tenant, {
          cdmVersion: 1,
          requires: ['fields'],
          createdBy: 'BE-071',
          permissions: initialPermissions(),
        });
        const ref = { tenant, doc: rec.id };
        return { ref, epoch: await logs.claim(ref, 'be-071') };
      }),
    );
    const latencies: number[] = [];
    let commits = 0;
    let appends = 0;
    let failures = 0;
    const stopAt = performance.now() + seconds * 1000;
    const began = performance.now();
    await Promise.all(
      refs.map(async ({ ref, epoch }) => {
        let seq = 1;
        while (performance.now() < stopAt) {
          const group = Array.from({ length: batch }, (_, i) => stepCommit(seq + i));
          const t0 = performance.now();
          const r = await logs.append(ref, write(epoch, group));
          const dt = performance.now() - t0;
          if (r.status !== 'ok') {
            failures += 1;
            continue;
          }
          seq += batch;
          commits += batch;
          appends += 1;
          latencies.push(dt);
        }
      }),
    );
    const elapsed = (performance.now() - began) / 1000;
    latencies.sort((x, y) => x - y);
    report.push({
      writers,
      commits,
      commitsPerSecond: Math.round(commits / elapsed),
      appendsPerSecond: Math.round(appends / elapsed),
      appendMedianMs: Number(quantile(latencies, 0.5).toFixed(1)),
      append99thMs: Number(quantile(latencies, 0.99).toFixed(1)),
      failures,
    });
    console.log(JSON.stringify(report.at(-1)));
  }
  const result = {
    measuredAt: new Date().toISOString(),
    machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model, platform: os.platform() },
    seconds,
    commitsPerAppend: batch,
    pool: { service: poolSize },
    postgres: settings,
    steps: report,
  };
  if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
} finally {
  await db.drop();
}
process.exit(0);
