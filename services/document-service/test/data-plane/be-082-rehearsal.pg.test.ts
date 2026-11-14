// BE-082 criterion 3 (lane U-BE-071-084): a restore rehearsal. Sample documents are written to a
// PostgreSQL database, the database is dumped with pg_dump inside the test PostgreSQL container
// (docedit-test-postgres, read only), restored into a new empty database, and the sample documents
// are verified there with the BE-081 command line (`verify` checks the chain and the checkpoints;
// `rebuild` gives the head hash, which must equal the source's). The rehearsal records its date,
// its duration and its result, and fails if the duration is above 15 minutes (the target in
// 06 9). The object store is the same bucket, not a restored copy: the rehearsal does not restore
// it. Every name carries U-BE-071-084 and the database and the objects are removed afterwards.
// Skips, with the reason, when PostgreSQL or the object store is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import {
  ADMIN,
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  settings,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const WORDS = ['Rehearsal alpha', 'Rehearsal beta', 'Rehearsal gamma'];
const TARGET_MS = 15 * 60 * 1000;
const PG_CONTAINER = 'docedit-test-postgres';

const S = settings();
const CONTAINER_CLI = S['DOCEDIT_CONTAINER_CLI'] || 'podman';
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
      { cwd: SERVICE_DIR, env: childEnv, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Runs the container CLI with optional stdin; stdout is kept as bytes (a dump is binary). */
function containerCli(
  args: string[],
  input?: Buffer,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONTAINER_CLI, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }),
    );
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

/** The PostgreSQL client tools inside the test container, over TCP as the schema owner. */
function toolArgs(tool: string[], database: string): string[] {
  return [
    'exec',
    '-i',
    '-e',
    `PGPASSWORD=${String(ADMIN.password)}`,
    PG_CONTAINER,
    ...tool,
    '-h',
    '127.0.0.1',
    '-p',
    String(ADMIN.port),
    '-U',
    String(ADMIN.user),
    ...(database ? ['-d', database] : []),
  ];
}

describe.skipIf(unavailable !== null)(
  'BE-082 criterion 3: restore rehearsal (U-BE-071-084)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;
    const tenants: string[] = [];
    const rehearsalDbs: string[] = [];
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
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        for (const name of rehearsalDbs)
          await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await root.end();
      }
      await db?.drop();
    });

    it(
      'restores a dump into an empty database, verifies the sample documents with BE-081, and records a duration under 15 minutes',
      async () => {
        // Sample documents: three commits each, a checkpoint at seq 0 in the object store.
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

        const sourceUrl = `postgres://${encodeURIComponent(String(ADMIN.user))}:${encodeURIComponent(String(ADMIN.password))}@${ADMIN.host}:${ADMIN.port}/${db.name}`;
        const env = {
          DOCEDIT_S3_HOST: S['DOCEDIT_S3_HOST'] ?? '',
          DOCEDIT_S3_PORT: S['DOCEDIT_S3_PORT'] ?? '',
          DOCEDIT_S3_REGION: s3Settings.region,
          DOCEDIT_S3_BUCKET: s3Settings.bucket,
          DOCEDIT_S3_ACCESS_KEY: s3Settings.accessKeyId,
          DOCEDIT_S3_SECRET_KEY: s3Settings.secretAccessKey,
        };
        const sourceHead = await runCli(['rebuild', '--tenant', tenant, '--doc', doc], {
          ...env,
          DOCEDIT_DATABASE_URL: sourceUrl,
        });
        expect(sourceHead.code, sourceHead.stderr).toBe(0);
        const sourceHash = sourceHead.stdout.split(/\s+/)[0];

        // The rehearsal starts here: dump, empty target, restore, verify.
        const started = Date.now();
        const dump = await containerCli(
          toolArgs(['pg_dump', '-Fc', '--no-owner', '--no-privileges'], db.name),
        );
        expect(dump.code, dump.stderr).toBe(0);
        expect(dump.stdout.length).toBeGreaterThan(0);

        const target = `docedit_rehearsal_U-BE-071-084_${randomBytes(4).toString('hex')}`;
        rehearsalDbs.push(target);
        const root = new pg.Client(ADMIN);
        await root.connect();
        try {
          await root.query(`CREATE DATABASE "${target}"`);
        } finally {
          await root.end();
        }

        const restore = await containerCli(
          toolArgs(['pg_restore', '--no-owner', '--no-privileges', '--exit-on-error'], target),
          dump.stdout,
        );
        expect(restore.code, restore.stderr).toBe(0);

        const targetUrl = `postgres://${encodeURIComponent(String(ADMIN.user))}:${encodeURIComponent(String(ADMIN.password))}@${ADMIN.host}:${ADMIN.port}/${target}`;
        const verify = await runCli(['verify', '--tenant', tenant, '--doc', doc], {
          ...env,
          DOCEDIT_DATABASE_URL: targetUrl,
        });
        const rebuilt = await runCli(['rebuild', '--tenant', tenant, '--doc', doc], {
          ...env,
          DOCEDIT_DATABASE_URL: targetUrl,
        });
        const durationMs = Date.now() - started;

        // The rehearsal's record: date, duration and result, printed for the run's log.
        const result =
          verify.code === 0 && rebuilt.code === 0 && rebuilt.stdout.split(/\s+/)[0] === sourceHash;
        console.log(
          JSON.stringify({
            rehearsal: 'U-BE-071-084 BE-082',
            date: new Date(started).toISOString(),
            durationMs,
            result: result ? 'pass' : 'fail',
            verify: verify.stdout.trim(),
            rebuilt: rebuilt.stdout.trim(),
          }),
        );

        expect(verify.code, verify.stderr).toBe(0);
        expect(verify.stdout).toContain('chain ok up to seq 3');
        expect(rebuilt.stdout.split(/\s+/)[0]).toBe(sourceHash);
        expect(durationMs).toBeLessThan(TARGET_MS);
      },
      10 * 60 * 1000,
    );
  },
);
