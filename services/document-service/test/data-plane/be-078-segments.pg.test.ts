/**
 * BE-078 criteria 1 and 2 for cold segments (HIS-029), against PostgreSQL and the S3-compatible store:
 * a database restored to an earlier point leaves a segment object whose range ends past the head.
 * The command (src/data-plane/recovery-cli.ts, a child process) lists that document in the dry run and,
 * in the full run, gives it a new incarnation, audits it and sets the segment aside. The file skips,
 * with the reason, when PostgreSQL or the object store is not up: pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
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
  'recovery-cli.ts incarnation and cold segments against PostgreSQL and S3 (BE-078 criteria 1 and 2)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;
    const tenants: string[] = [];
    const store = new S3ObjectStore(s3Settings);

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      await plane?.close().catch(() => {});
      for (const t of tenants)
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      await db?.drop();
    });

    it('lists a document whose cold segment ends past its restored head, and the full run sets that segment aside', async () => {
      const s = pgStores(db.service);
      const objects = new ObjectCheckpointStore(store);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        deps: { checkpoints: objects },
      });
      const tenant = plane.tenant;
      tenants.push(tenant);

      let channel = 0;
      async function document(): Promise<string> {
        const doc = await plane!.createDocument();
        const ref = plane!.ref(doc);
        await objects.put(ref, 0, (await plane!.checkpoints.get(ref, 0))!);
        const alice = await plane!.client('alice', { [doc]: 'owner' });
        const ch = ++channel;
        const opened = await alice.open(ch, doc);
        if (opened.t !== 'ch.opened') throw new Error(`open ${doc}: ${JSON.stringify(opened)}`);
        for (let i = 0; i < WORDS.length; i++) {
          const r = await alice.submit(ch, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
          if (r.t !== 'sync.ack') throw new Error(`doc ${doc} submit ${i}: ${JSON.stringify(r)}`);
        }
        return doc;
      }
      // `restored`: the head goes back to 2; a segment of 1 to 3 was written after that point, and
      // one of 1 to 2 before it. `whole`: its segment ends at its head. `bare`: no segment.
      const restored = await document();
      const whole = await document();
      const bare = await document();
      await plane.close();
      plane = undefined;
      const put = (doc: string, from: number, to: number) =>
        store.put(
          objectKeys.segment(tenant, doc, from, to),
          new TextEncoder().encode(`${from}-${to}`),
        );
      await put(restored, 1, 2);
      await put(restored, 1, 3);
      await put(whole, 1, 3);
      const admin = db.admin;
      await admin.query('UPDATE doc_heads SET head_seq = 2 WHERE doc_id = $1', [restored]);
      // The room's close wrote a checkpoint at the head of each document; none is past a head
      // except the restored document's, which the index of this database does not record.
      await admin.query('DELETE FROM doc_checkpoints WHERE doc_id = $1 AND seq > 2', [restored]);

      const incarnations = async () =>
        (
          await admin.query<{ doc_id: string; incarnation: string }>(
            'SELECT doc_id, incarnation FROM doc_heads WHERE doc_id = ANY($1::uuid[]) ORDER BY doc_id',
            [[restored, whole, bare]],
          )
        ).rows;
      const before = await incarnations();

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

      // Criterion 1: the dry run lists the document, by its segment alone, and changes nothing.
      const dry = await runCli(['incarnation', '--dry-run'], env);
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(`${tenant} ${restored}: head 2, segments 1-3`);
      expect(dry.stdout).not.toContain(whole);
      expect(dry.stdout).not.toContain(bare);
      expect(dry.stdout).toContain('1 documents would get a new incarnation; nothing was changed');
      expect(await incarnations()).toEqual(before);
      expect(await store.exists(objectKeys.segment(tenant, restored, 1, 3))).toBe(true);

      // Criterion 2: the full run gives that document a new incarnation, audits it, and sets the
      // segment past the head aside; the segment below the head and the other documents stay.
      const full = await runCli(['incarnation'], env);
      expect(full.code, full.stderr).toBe(0);
      expect(full.stdout).toContain(`${tenant} ${restored}: incarnation `);
      expect(full.stdout).toContain('segments 1-3');
      const after = await incarnations();
      const changed = after.filter((r, i) => r.incarnation !== before[i]!.incarnation);
      expect(changed.map((r) => r.doc_id)).toEqual([restored]);
      expect(await store.exists(objectKeys.segment(tenant, restored, 1, 3))).toBe(false);
      expect(await store.exists(objectKeys.segment(tenant, restored, 1, 2))).toBe(true);
      expect(await store.exists(objectKeys.segment(tenant, whole, 1, 3))).toBe(true);
      const aside = (await store.list(`tenants/${tenant}/docs/${restored}/aside/`)).filter((k) =>
        k.endsWith('/segments/1-3.payloads.zst'),
      );
      expect(aside).toHaveLength(1);
      const audit = await admin.query<{ data: { segments?: unknown } }>(
        "SELECT data FROM audit_events WHERE doc_id = $1 AND kind = 'incarnation.changed'",
        [restored],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.data.segments).toEqual([{ from: 1, to: 3 }]);
      // Run again: nothing is left.
      const again = await runCli(['incarnation', '--dry-run'], env);
      expect(again.stdout).toContain('0 documents would get a new incarnation');
    });
  },
);
