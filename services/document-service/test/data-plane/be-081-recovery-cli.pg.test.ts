/**
 * BE-081 criteria 1 and 2 against PostgreSQL and the S3-compatible store (06 §9, §11). The
 * command line (`src/data-plane/recovery-cli.ts`) runs as a child process with the operator's
 * settings, and needs no running service: `rebuild` prints the canonical hash at a `seq` and
 * exits 0; `verify` recomputes the hash chain and exits 1 naming the first broken `seq`.
 * Each run uses its own database and its own tenant prefix in the shared bucket, and removes
 * its objects. The file skips, with the reason, when PostgreSQL or the object store is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
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
const WORDS = ['Recovery alpha', 'Recovery beta', 'Recovery gamma'];

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
  'recovery-cli.ts against PostgreSQL and the object store (BE-081 criteria 1 and 2)',
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
      // Remove this run's objects: every key of a run's tenant starts with its prefix.
      const store = new S3ObjectStore(s3Settings);
      for (const t of tenants) {
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      }
      await db?.drop();
    });

    /** Three commits in a new document, a checkpoint at seq 0 in the object store. */
    async function document(): Promise<{
      doc: string;
      tenant: string;
      env: Record<string, string>;
    }> {
      const s = pgStores(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        deps: { checkpoints: objects },
      });
      const tenant = plane.tenant;
      tenants.push(tenant);
      const doc = await plane.createDocument();
      const ref = plane.ref(doc);
      await objects.put(ref, 0, (await plane.checkpoints.get(ref, 0))!);
      const alice = await plane.client('alice', { [doc]: 'owner' });
      await alice.open(1, doc);
      for (let i = 0; i < WORDS.length; i++) {
        const r = await alice.submit(1, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
        expect(r.t).toBe('sync.ack');
      }
      await plane.close();
      plane = undefined;
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
      return { doc, tenant, env };
    }

    it('criterion 1: rebuild prints the canonical hash at the head and at a given seq, and exits 0', async () => {
      const { doc, tenant, env } = await document();
      const head = await runCli(['rebuild', '--tenant', tenant, '--doc', doc], env);
      expect(head.code, head.stderr).toBe(0);
      expect(head.stdout).toMatch(/^[0-9a-f]{64}\s+seq 3\b/);

      const atTwo = await runCli(['rebuild', '--tenant', tenant, '--doc', doc, '--seq', '2'], env);
      expect(atTwo.code, atTwo.stderr).toBe(0);
      expect(atTwo.stdout).toMatch(/^[0-9a-f]{64}\s+seq 2\b/);
      // The hash at a seq is a function of the log: asking again gives the same answer.
      const again = await runCli(['rebuild', '--tenant', tenant, '--doc', doc], env);
      expect(again.stdout.split(/\s+/)[0]).toBe(head.stdout.split(/\s+/)[0]);
      expect(atTwo.stdout.split(/\s+/)[0]).not.toBe(head.stdout.split(/\s+/)[0]);
    });

    it('criterion 2: verify recomputes the chain and exits 1 naming the first broken seq', async () => {
      const { doc, tenant, env } = await document();
      const clean = await runCli(['verify', '--tenant', tenant, '--doc', doc], env);
      expect(clean.code, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('chain ok up to seq 3');

      // Alter the stored size of commit 2, as a tamper of the rows would. The database's
      // append-only protection is bypassed for this one statement by replication role, which
      // only the schema owner may set; the session's role is reset before the connection returns.
      const conn = await db.admin.connect();
      try {
        await conn.query("SET session_replication_role = 'replica'");
        const r = await conn.query(
          'UPDATE doc_commits SET size = size + 1 WHERE doc_id = $1 AND seq = 2',
          [doc],
        );
        expect(r.rowCount).toBe(1);
      } finally {
        await conn.query('RESET session_replication_role').catch(() => {});
        conn.release();
      }

      const broken = await runCli(['verify', '--tenant', tenant, '--doc', doc], env);
      expect(broken.code).toBe(1);
      expect(broken.stderr).toContain('broken at seq 2');
      expect(broken.stdout).not.toContain('chain ok');
    });
  },
);
