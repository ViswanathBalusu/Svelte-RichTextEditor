// SYN-039 criterion 1 over PostgreSQL (lane V-SYN-037-053): the room's heavy work runs in a worker
// thread, not on the room's event loop. Covered here: a checkpoint write (the `checkpoint` task), a
// log replay for a content read (`materialise`), and a conversion (`encode`, the envelope to its
// stored form). Not covered here: a comparison. The only comparison that reaches the room is the
// divergence hash, which the checkpoint task computes; `recovery.ts`'s verify runs inline in a
// command-line tool and is not the room's work. Skips, with the reason, when PostgreSQL is not up.
import { threadId } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'V-SYN-037-053: heavy room work runs in worker threads over PostgreSQL (SYN-039 criterion 1)',
  () => {
    let db: TestDatabase;
    let plane: Plane | undefined;

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await plane?.close().catch(() => {});
      await db?.drop();
    });

    it('runs the checkpoint write, the content replay and the conversion in the pool, never inline', async () => {
      const s = pgStores(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        settings: {
          workers: 1,
          workerTimeoutMs: 30_000,
          checkpoint: { everyCommits: 2, everyMs: 600_000, minIntervalMs: 0 },
        },
      });
      const pool = plane.plane.workers;
      const { threadId: workerThread } = await pool.run('thread', null);
      expect(workerThread).not.toBe(threadId);

      const doc = await plane.createDocument();
      const ref = plane.ref(doc);
      const alice = await plane.client('alice', { [doc]: 'owner' });
      const opened = await alice.open(1, doc);
      if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);
      const words = ['worker one', 'worker two', 'worker three'];
      const submit = async (i: number) => {
        const r = await alice.submit(1, { base: i, steps: [insertText(intro(), words[i]!)] });
        if (r.t !== 'sync.ack') throw new Error(`submit ${i}: ${JSON.stringify(r)}`);
      };

      // 1. Checkpoint write: the checkpoint due after the second commit is serialised by a task.
      const beforeWrite = { ...pool.stats };
      await submit(0);
      await submit(1);
      for (let k = 0; k < 250 && (await plane.checkpoints.get(ref, 2)) === null; k++)
        await new Promise((r) => setTimeout(r, 20));
      expect(await plane.checkpoints.get(ref, 2), 'the checkpoint at seq 2').not.toBeNull();
      expect(pool.stats.run - beforeWrite.run, 'the checkpoint went to the pool').toBeGreaterThan(
        0,
      );
      expect(pool.stats.inline, 'no inline work for the checkpoint').toBe(beforeWrite.inline);

      // 2. Log replay for a content read: the third commit is replayed on the checkpoint at 2.
      await submit(2);
      // The room answers from memory while it is loaded; stop it so that the read replays the log.
      expect(plane.plane.host.kill(ref)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      const beforeRead = { ...pool.stats };
      const identity = plane.tokens.identity(alice.token!);
      const read = await plane.plane.readContent(identity, doc);
      expect(read.seq).toBe(3);
      expect(JSON.stringify(read.doc)).toContain(words[2]!);
      expect(pool.stats.run - beforeRead.run, 'the replay went to the pool').toBeGreaterThan(0);
      expect(pool.stats.inline, 'no inline replay').toBe(beforeRead.inline);

      // 3. Conversion: content becomes its stored form (canonical text, Zstandard, SHA-256) in a task.
      const beforeConvert = { ...pool.stats };
      const envelope = (await plane.checkpoints.get(ref, 2))!;
      const encoded = await plane.plane.host.encode(envelope);
      expect(encoded.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(pool.stats.run - beforeConvert.run, 'the conversion went to the pool').toBeGreaterThan(
        0,
      );
      expect(pool.stats.inline, 'no inline conversion').toBe(beforeConvert.inline);
      expect(plane.errors).toEqual([]);
    });
  },
);
