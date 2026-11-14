// BE-020 criterion 3 (lane V-BE-015-028): checkpoint serialisation runs in a worker thread (SYN-039),
// the room keeps acknowledging commits while it runs, and nothing falls back to inline work. The
// plane is the real one over the in-memory stores, with a pool of one worker thread; the other BE-020
// tests run inline (workers: 0).
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { insertText } from './client.ts';
import { MemoryCheckpoints, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

class SpyCheckpoints extends MemoryCheckpoints {
  readonly seqs: number[] = [];
  override async put(ref: DocRef, seq: number, content: Parameters<MemoryCheckpoints['put']>[2]) {
    this.seqs.push(seq);
    return super.put(ref, seq, content);
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('checkpoint serialisation runs in a worker thread (BE-020 criterion 3)', () => {
  it('runs the checkpoint in a worker thread and keeps acknowledging commits meanwhile', async () => {
    const checkpoints = new SpyCheckpoints();
    const p = await startPlane({
      checkpoints,
      settings: {
        workers: 1,
        workerTimeoutMs: 30_000,
        checkpoint: { everyCommits: 2, everyMs: 600_000, minIntervalMs: 0 },
      },
    });
    planes.push(p);
    const pool = p.plane.workers;

    // The pool really runs off the main thread: a task reports the worker's thread identifier.
    const mainThread = (await import('node:worker_threads')).threadId;
    const { threadId: workerThread } = await pool.run('thread', null);
    expect(workerThread).not.toBe(mainThread);
    const before = { ...pool.stats };

    const doc = await p.createDocument();
    checkpoints.seqs.length = 0;

    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');

    // Commits keep arriving while the checkpoint due after the second commit is serialised.
    const acks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await alice.submit(1, {
        base: i,
        steps: [insertText(intro(), `worker commit ${i + 1}`)],
      });
      acks.push(r.t);
    }
    expect(acks).toEqual(Array(6).fill('sync.ack'));

    await until(() => checkpoints.seqs.length > 0, 10_000, 'a checkpoint written by the worker');
    expect(p.errors).toEqual([]);

    // The checkpoint work went to the pool (run counted, none inline), and the pool never had to
    // replace a worker that died or timed out.
    expect(pool.stats.run - before.run).toBeGreaterThan(0);
    expect(pool.stats.inline).toBe(before.inline);
    expect(pool.stats.replaced).toBe(before.replaced);
  });
});
