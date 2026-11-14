// BE-020 criterion 3, the part the worker test does not show (lane V-BE-015-028): a checkpoint is
// serialised from the durable state only. Commit A is stored, and its checkpoint comes due while
// commit B is held in the log store (in flight, not yet stored, so tentative in the room). The
// checkpoint written at seq 1 must hold A and not B, and it must be written while B is still held.
// The plane is the real one in process, over the in-memory stores, with a pool of one worker thread
// and held log writes (GatedLogStore).
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from './client.ts';
import { GatedLogStore, MemoryCheckpoints, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

class RecordingCheckpoints extends MemoryCheckpoints {
  readonly writes: Array<{ seq: number; text: string; pendingWhileWriting: number }> = [];
  private readonly pending: () => number;
  constructor(pending: () => number) {
    super();
    this.pending = pending;
  }
  override async put(ref: DocRef, seq: number, content: Parameters<MemoryCheckpoints['put']>[2]) {
    this.writes.push({ seq, text: JSON.stringify(content), pendingWhileWriting: this.pending() });
    return super.put(ref, seq, content);
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a checkpoint is serialised from the durable state only (BE-020 criterion 3)', () => {
  it('writes the checkpoint of stored commit A while commit B, still tentative, is held in the store', async () => {
    const mem = new MemoryStore();
    const gated = new GatedLogStore(mem);
    const checkpoints = new RecordingCheckpoints(() => gated.pending);
    const p = await startPlane({
      stores: { logs: gated, ownership: mem, grants: mem, documents: mem },
      checkpoints,
      settings: {
        workers: 1,
        workerTimeoutMs: 30_000,
        checkpoint: { everyCommits: 2000, everyMs: 200, minIntervalMs: 0 },
      },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const ref: DocRef = { tenant: p.tenant, doc };
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');

    // Commit A is stored normally; its time-based checkpoint is due 200 ms after it.
    const a = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'stored commit')] });
    expect(a.t).toBe('sync.ack');

    // Commit B is held in the log store: in flight, not durable, tentative in the room.
    gated.hold = true;
    const b = alice.submit(1, { base: 1, steps: [insertText(intro(), 'tentative commit')] });
    await until(() => gated.pending === 1, 3000, 'commit B to reach the store');

    try {
      // The checkpoint of A is written while B is still held. (The checkpoint at seq 0 comes first.)
      await until(
        () => checkpoints.writes.some((w) => w.seq === 1),
        10_000,
        'the checkpoint of stored commit A',
      );
      const cp = checkpoints.writes.find((w) => w.seq === 1);
      expect(cp!.pendingWhileWriting).toBe(1);
      expect(cp!.text).toContain('stored commit');
      expect(cp!.text).not.toContain('tentative commit');
      expect((await mem.head(ref)).seq).toBe(1);
    } finally {
      gated.hold = false;
      await gated.release().catch(() => {});
    }
    expect((await b).t).toBe('sync.ack');
    expect((await mem.head(ref)).seq).toBe(2);
    expect(p.errors).toEqual([]);
  }, 30_000);
});
