/**
 * BE-078 criterion 1 (the dry run of the new-incarnation command) against PostgreSQL and the
 * S3-compatible store. The restored database is simulated: a document whose head was moved back
 * below a checkpoint the object store still holds. The command runs as a child process with
 * `incarnation --dry-run` (src/data-plane/recovery-cli.ts) and must list that document only and
 * change nothing. The file skips, with the reason, when PostgreSQL or the object store is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { contentHash } from '../../src/data-plane/recovery.ts';
import { PgCheckpointIndex } from '../../src/data-plane/pg/checkpoint-index.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { objectKeys } from '../../src/objects/store.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  settings,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const WORDS = ['Restore alpha', 'Restore beta', 'Restore gamma'];

const S = settings();
const s3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

const CLI = fileURLToPath(new URL('../../src/data-plane/recovery-cli.ts', import.meta.url));
const SERVICE_DIR = fileURLToPath(new URL('../../', import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv['DOCEDIT_S3_ENDPOINT'];
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: SERVICE_DIR, env: childEnv, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe.skipIf(unavailable !== null)(
  'recovery-cli.ts incarnation --dry-run against PostgreSQL (BE-078 criterion 1)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;
    const tenants: string[] = [];
    const objects = new ObjectCheckpointStore(new S3ObjectStore(s3Settings));

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      await plane?.close().catch(() => {});
      const store = new S3ObjectStore(s3Settings);
      for (const t of tenants) {
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      }
      await db?.drop();
    });

    it('lists the one document whose checkpoint reaches past its restored head, and changes nothing', async () => {
      const s = pgStores(db.service);
      const index = new PgCheckpointIndex(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        deps: { checkpoints: objects },
      });
      const tenant = plane.tenant;
      tenants.push(tenant);

      /** Three commits; checkpoints at the given seqs in the object store and in the index. */
      let channel = 0;
      async function document(checkpoints: number[]): Promise<string> {
        const doc = await plane!.createDocument();
        const ref = plane!.ref(doc);
        const envelope = (await plane!.checkpoints.get(ref, 0))!;
        // The room opens from the object store's checkpoint at 0, as in production.
        await objects.put(ref, 0, envelope);
        const alice = await plane!.client('alice', { [doc]: 'owner' });
        // One channel per document: the same client keeps its channels open across documents.
        const ch = ++channel;
        const opened = await alice.open(ch, doc);
        if (opened.t !== 'ch.opened') throw new Error(`open ${doc}: ${JSON.stringify(opened)}`);
        for (let i = 0; i < WORDS.length; i++) {
          const r = await alice.submit(ch, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
          if (r.t !== 'sync.ack') throw new Error(`doc ${doc} submit ${i}: ${JSON.stringify(r)}`);
        }
        for (const seq of checkpoints) {
          if (seq !== 0) await objects.put(ref, seq, envelope);
          await index.record(ref, {
            seq,
            key: objectKeys.checkpoint(tenant, doc, seq),
            bytes: JSON.stringify(envelope).length,
            hash: contentHash(envelope),
          });
        }
        return doc;
      }

      // Affected: head 3 is restored to 2, the object store still holds the checkpoint at 3.
      const restored = await document([0, 3]);
      // Not affected: the checkpoint is below the head.
      const behind = await document([0]);
      // Not affected: the checkpoint is at the head, not past it.
      const atHead = await document([0, 3]);
      await plane.close();
      plane = undefined;

      const admin = db.admin;
      await admin.query('UPDATE doc_heads SET head_seq = 2 WHERE doc_id = $1', [restored]);

      const before = await admin.query<{ doc_id: string; incarnation: string }>(
        'SELECT doc_id, incarnation FROM doc_heads WHERE doc_id = ANY($1::uuid[]) ORDER BY doc_id',
        [[restored, behind, atHead]],
      );
      const beforeSet = await admin.query<{
        doc_id: string;
        seq: string;
        set_aside_at: Date | null;
      }>('SELECT doc_id, seq, set_aside_at FROM doc_checkpoints WHERE doc_id = ANY($1::uuid[])', [
        [restored, behind, atHead],
      ]);

      const c = db.serviceConfig;
      const env = {
        DOCEDIT_DATABASE_URL: `postgres://${encodeURIComponent(String(c.user))}:${encodeURIComponent(String(c.password))}@${c.host}:${c.port}/${c.database}`,
        DOCEDIT_S3_HOST: S['DOCEDIT_S3_HOST'] ?? '',
        DOCEDIT_S3_PORT: S['DOCEDIT_S3_PORT'] ?? '',
        DOCEDIT_S3_REGION: s3Settings.region,
        DOCEDIT_S3_BUCKET: s3Settings.bucket,
        DOCEDIT_S3_ACCESS_KEY: s3Settings.accessKeyId,
        DOCEDIT_S3_SECRET_KEY: s3Settings.secretAccessKey,
      };
      const dry = await runCli(['incarnation', '--dry-run'], env);
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(`${tenant} ${restored}: head 2, checkpoint 3`);
      expect(dry.stdout).not.toContain(behind);
      expect(dry.stdout).not.toContain(atHead);
      expect(dry.stdout).toContain('1 documents would get a new incarnation; nothing was changed');

      // Nothing changed: the incarnations, the checkpoints (none set aside) and the objects stay.
      const after = await admin.query<{ doc_id: string; incarnation: string }>(
        'SELECT doc_id, incarnation FROM doc_heads WHERE doc_id = ANY($1::uuid[]) ORDER BY doc_id',
        [[restored, behind, atHead]],
      );
      expect(after.rows).toEqual(before.rows);
      const afterSet = await admin.query<{
        doc_id: string;
        seq: string;
        set_aside_at: Date | null;
      }>('SELECT doc_id, seq, set_aside_at FROM doc_checkpoints WHERE doc_id = ANY($1::uuid[])', [
        [restored, behind, atHead],
      ]);
      expect(afterSet.rows.map((r) => r.set_aside_at)).toEqual(
        beforeSet.rows.map((r) => r.set_aside_at),
      );
      expect(afterSet.rows.every((r) => r.set_aside_at === null)).toBe(true);
      expect(await objects.get({ tenant, doc: restored }, 3)).not.toBeNull();
    });
  },
);
