/**
 * BE-020 criterion 4 (lane U-BE-015-028): a checkpoint written by a running room is stored as an
 * object under its key, and its `doc_checkpoints` row holds that key, the `seq`, the object's size
 * and the content hash. Runs against PostgreSQL and the S3-compatible store. The file skips, with
 * the reason, when either is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 *
 * The tenant is a UUID (the column type), so the lane name is not in it; the test deletes only the
 * objects under that tenant's prefix and drops its own database.
 *
 * Not covered here: the attribution map and comment-range side object (they exist only with HIS-014,
 * which is not built), and the thinning check of criterion 5.
 */
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize } from '@docedit/model';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { PgCheckpointIndex } from '../../src/data-plane/pg/checkpoint-index.ts';
import { contentHash } from '../../src/data-plane/recovery.ts';
import type { CheckpointRow } from '../../src/storage/types.ts';
import { ObjectCheckpointStore, decodeCheckpoint } from '../../src/objects/checkpoints.ts';
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
const WORDS = ['Checkpoint alpha', 'Checkpoint beta', 'Checkpoint gamma'];

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

describe.skipIf(unavailable !== null)(
  'a room writes a checkpoint object and its index row in PostgreSQL (BE-020 criterion 4)',
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

    it('stores the canonical document under its key and records key, seq, size and hash', async () => {
      const s = pgStores(db.service);
      const index = new PgCheckpointIndex(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        // A checkpoint after every second stored commit, with no minimum spacing.
        settings: { checkpoint: { everyCommits: 2, everyMs: 600_000, minIntervalMs: 0 } },
        deps: { checkpoints: objects, checkpointIndex: index },
      });
      const tenant = plane.tenant;
      tenants.push(tenant);

      const doc = await plane.createDocument();
      const ref = plane.ref(doc);
      // The room opens from the object store's content at 0, as in production (D67).
      await objects.put(ref, 0, (await plane.checkpoints.get(ref, 0))!);

      const alice = await plane.client('alice', { [doc]: 'owner' });
      const opened = await alice.open(1, doc);
      if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);
      for (let i = 0; i < WORDS.length; i++) {
        const r = await alice.submit(1, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
        if (r.t !== 'sync.ack') throw new Error(`submit ${i}: ${JSON.stringify(r)}`);
      }

      // The room writes its checkpoint after the commit is answered: wait for the index row.
      let rows: CheckpointRow[] = [];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        rows = (await index.list(ref)).filter((r) => r.seq > 0);
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(rows.length, 'a checkpoint row at seq > 0').toBeGreaterThan(0);
      const row = rows[rows.length - 1]!;

      // The index row: key, seq, size and hash agree with the object the room stored.
      expect(row.key).toBe(objectKeys.checkpoint(tenant, doc, row.seq));
      const bytes = await objects.getEncoded(ref, row.seq);
      expect(bytes, 'the object under the recorded key').not.toBeNull();
      expect(row.bytes).toBe(bytes!.byteLength);

      // The object holds the canonical document: its text is the canonical form of its content,
      // its hash is the one the index records, and it holds every commit up to its seq.
      const envelope = decodeCheckpoint(bytes!);
      expect(row.hash).toBe(contentHash(envelope));
      expect(zstdDecompressSync(bytes!).toString('utf8')).toBe(canonicalize(envelope));
      for (let k = 0; k < row.seq; k++) {
        expect(JSON.stringify(envelope), `commit ${k + 1} in the checkpoint`).toContain(WORDS[k]!);
      }
    });
  },
);
