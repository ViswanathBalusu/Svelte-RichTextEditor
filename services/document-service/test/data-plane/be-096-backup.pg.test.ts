/**
 * BE-096 criteria 1 to 3 against PostgreSQL and the S3-compatible store (06 §13; 10 §3.7). The
 * database is dumped with `pg_dump` and restored with `psql` inside the test PostgreSQL container
 * (`podman exec`), so the backup is of a real database and the rehearsal restores a real one into a
 * scratch database of its own. Every name carries the lane tag `u-be-085-098`, and the file removes
 * its objects, its audit rows (with its database) and its scratch database. The file skips, with the
 * reason, when PostgreSQL, the object store or the container is not up:
 *   pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { tenantKeyId } from '../../src/objects/encrypted-store.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import {
  backupKey,
  BackupError,
  copyBackup,
  readBackup,
  rehearse,
  writeBackup,
  type BackupKey,
  type RehearsalRecord,
} from '../../src/data-plane/backup.ts';
import { PgCheckpointIndex } from '../../src/data-plane/pg/checkpoint-index.ts';
import { PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { rebuild } from '../../src/data-plane/recovery.ts';
import { PgGrantStore } from '../../src/storage/grant-store.ts';
import { PgLogStore } from '../../src/storage/log-store.ts';
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

const TAG = 'u-be-085-098';
const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const WORDS = ['Backup alpha', 'Backup beta', 'Backup gamma'];

const S = settings();
const CLI = S['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
const CONTAINER = S['DOCEDIT_PG_CONTAINER'] ?? 'docedit-test-postgres';
/** The server listens on the test port inside the container (infra/containers/compose.json). */
const PORT = S['DOCEDIT_PG_PORT'] ?? '5432';
const s3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

interface Exec {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs a command inside the test PostgreSQL container, with `input` on its standard input. */
function inContainer(args: string[], input?: Uint8Array): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(CLI, ['exec', ...(input ? ['-i'] : []), CONTAINER, ...args], {
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => resolve({ code: 1, stdout: Buffer.alloc(0), stderr: String(e) }));
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }),
    );
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
}

async function containerUnavailable(): Promise<string | null> {
  const r = await inContainer(['pg_isready', '-p', PORT, '-U', 'postgres']);
  return r.code === 0
    ? null
    : `the container ${CONTAINER} is not ready (${r.stderr.trim() || 'pg_isready failed'})`;
}

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable =
  (await postgresUnavailable()) ?? (await s3Unavailable()) ?? (await containerUnavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

const BACKUP_KEY_TEXT = Buffer.alloc(32, 0x5a).toString('base64');
const OTHER_KEY_TEXT = Buffer.alloc(32, 0x33).toString('base64');

describe.skipIf(unavailable !== null)(
  'backups of PostgreSQL and the object store (BE-096 criteria 1 to 3)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;
    const tenants: string[] = [];
    const backups: string[] = [];
    const scratch: string[] = [];
    const objects = new ObjectCheckpointStore(new S3ObjectStore(s3Settings));
    const kek: BackupKey = backupKey(BACKUP_KEY_TEXT);
    const live = { doc: '', tenant: '', expected: '' };

    beforeAll(async () => {
      db = await createTestDatabase();
      const s = pgStores(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        deps: { checkpoints: objects },
      });
      live.tenant = plane.tenant;
      tenants.push(plane.tenant);
      const doc = await plane.createDocument();
      live.doc = doc;
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
      const hash = await rebuild({ logs: s.logs, checkpoints: objects }, ref);
      live.expected = hash.hash;
    });

    afterAll(async () => {
      await plane?.close().catch(() => {});
      const store = new S3ObjectStore(s3Settings);
      for (const t of tenants)
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      for (const key of backups) await store.delete(key).catch(() => {});
      for (const name of scratch) {
        await dropDatabase(name);
      }
      await db?.drop();
    });

    /** The live database as plain SQL, from the container's `pg_dump`. */
    async function dumpDatabase(): Promise<Uint8Array> {
      const r = await inContainer([
        'pg_dump',
        '-p',
        PORT,
        '-U',
        'postgres',
        '-d',
        db.name,
        '--format=plain',
        '--no-owner',
        '--no-privileges',
      ]);
      if (r.code !== 0) throw new Error(`pg_dump failed: ${r.stderr.trim()}`);
      return r.stdout;
    }

    async function dropDatabase(name: string): Promise<void> {
      const c = new pg.Client(ADMIN);
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    }

    /** A scratch database restored from the dump with `psql`, with the stores the recovery reads. */
    async function restoreScratch(database: Uint8Array) {
      const name = `docedit_${TAG.replace(/-/g, '_')}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const c = new pg.Client(ADMIN);
      await c.connect();
      try {
        await c.query(`CREATE DATABASE ${name} TEMPLATE template0`);
      } finally {
        await c.end();
      }
      scratch.push(name);
      const psql = await inContainer(
        ['psql', '-p', PORT, '-U', 'postgres', '-d', name, '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
        database,
      );
      if (psql.code !== 0)
        throw new Error(`psql restore failed: ${psql.stderr.trim().slice(0, 300)}`);
      const pool = new pg.Pool({ ...ADMIN, database: name, max: 4 });
      const grants = new PgGrantStore(pool);
      const logs = new PgLogStore(pool, { permissions: (ref) => grants.current(ref) });
      return {
        logs,
        verify: (ref: { tenant: string; doc: string }, opts: { payloads?: boolean }) =>
          logs.verify(ref, opts),
        index: new PgCheckpointIndex(pool),
        close: async () => {
          await pool.end();
          await dropDatabase(name);
        },
      };
    }

    /** The bucket keys of this run's backups, distinct per test. */
    const newKey = () => {
      const key = `backups/${TAG}-${randomUUID()}.debk`;
      backups.push(key);
      return key;
    };

    it("criterion 1: the backup holds the database and the sealed objects, under a backup key apart from the tenants' keys", async () => {
      const store = new S3ObjectStore(s3Settings);
      const key = newKey();
      const receipt = await writeBackup({
        source: { dumpDatabase, objects: store },
        tenants: [live.tenant],
        kek,
        target: store,
        targetKey: key,
        audit: { audit: new PgAuditStore(db.service), actor: `operator:${TAG}` },
      });
      expect(receipt.objects).toBeGreaterThan(0);

      // The stored file holds no plain text of the document or of the database.
      const sealed = Buffer.from((await store.get(key))!);
      expect(sealed.includes(Buffer.from(WORDS[0]!))).toBe(false);
      expect(sealed.includes(Buffer.from('CREATE TABLE'))).toBe(false);

      // Another backup key does not open it; the key's identifier is not a tenant key's.
      await expect(
        readBackup({
          target: store,
          key,
          kek: backupKey(OTHER_KEY_TEXT),
          audit: { audit: new PgAuditStore(db.service), actor: 'operator' },
        }),
      ).rejects.toThrow(BackupError);
      expect(kek.id).not.toBe(tenantKeyId(live.tenant));
      expect(kek.id).not.toBe(backupKey(OTHER_KEY_TEXT).id);
    });

    it('criterion 2: each write, read and copy is in the audit trail with the actor, the backup and counts', async () => {
      const store = new S3ObjectStore(s3Settings);
      const audit = new PgAuditStore(db.service);
      const actor = `operator:${TAG}`;
      const key = newKey();
      await writeBackup({
        source: { dumpDatabase, objects: store },
        tenants: [live.tenant],
        kek,
        target: store,
        targetKey: key,
        audit: { audit, actor },
      });
      const bundle = await readBackup({ target: store, key, kek, audit: { audit, actor } });
      expect(bundle.tenants).toEqual([live.tenant]);
      const copy = newKey();
      await copyBackup({ target: store, from: key, to: copy, kek, audit: { audit, actor } });

      const events = await audit.query(live.tenant, { limit: 500 });
      const mine = events.filter(
        (e) => e.actor === actor && [key, copy].includes(String(e.data['backup'])),
      );
      expect(mine.map((e) => e.kind)).toEqual(
        expect.arrayContaining(['backup.written', 'backup.read', 'backup.copied']),
      );
      const written = mine.find((e) => e.kind === 'backup.written')!;
      expect(written.data).toMatchObject({ backup: key, objects: expect.any(Number) });
      expect(JSON.stringify(mine)).not.toContain(WORDS[0]!);
      expect(JSON.stringify(mine)).not.toContain('CREATE TABLE');
    });

    it('criterion 3: a rehearsal restores the dump into a scratch database and checks the samples against the live hashes', async () => {
      const store = new S3ObjectStore(s3Settings);
      const audit = new PgAuditStore(db.service);
      const actor = `operator:${TAG}`;
      const key = newKey();
      await writeBackup({
        source: { dumpDatabase, objects: store },
        tenants: [live.tenant],
        kek,
        target: store,
        targetKey: key,
        audit: { audit, actor },
      });
      const bundle = await readBackup({ target: store, key, kek, audit: { audit, actor } });

      const record: RehearsalRecord = await rehearse({
        bundle,
        backup: key,
        restore: restoreScratch,
        samples: [{ tenant: live.tenant, doc: live.doc, expected: live.expected }],
        audit: { audit, actor },
      });
      expect(record.result, JSON.stringify(record.samples)).toBe('passed');
      expect(record.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(record.samples).toEqual([
        expect.objectContaining({
          doc: live.doc,
          ok: true,
          hash: live.expected,
          seq: WORDS.length,
        }),
      ]);

      // A sample whose live hash is not the restored one is reported as a failed rehearsal.
      const wrong = await rehearse({
        bundle,
        backup: key,
        restore: restoreScratch,
        samples: [{ tenant: live.tenant, doc: live.doc, expected: '0'.repeat(64) }],
        audit: { audit, actor },
      });
      expect(wrong.result).toBe('failed');
      expect(wrong.samples[0]).toMatchObject({
        ok: false,
        reason: 'the head hash differs from the live hash',
      });

      const rehearsals = (await audit.query(live.tenant, { limit: 500 })).filter(
        (e) => e.kind === 'backup.rehearsed' && e.data['backup'] === key,
      );
      expect(rehearsals.map((e) => e.data['result']).sort()).toEqual(['failed', 'passed']);
      expect(rehearsals.find((e) => e.data['result'] === 'passed')!.data['samples']).toEqual([
        { doc: live.doc, seq: WORDS.length, ok: true },
      ]);
      // The scratch copies are dropped after each rehearsal.
      const c = new pg.Client(ADMIN);
      await c.connect();
      try {
        const r = await c.query('SELECT datname FROM pg_database WHERE datname = ANY($1)', [
          scratch,
        ]);
        expect(r.rows).toEqual([]);
      } finally {
        await c.end();
      }
    }, 240_000);
  },
);
