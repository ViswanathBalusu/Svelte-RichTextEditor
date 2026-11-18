// SYN-032 criterion 6 (host half; BE-020; owner decision 81 of 2026-11-15): when a checkpoint is
// written, the comment ranges the room holds are saved with it, as a side object at the same seq,
// and a room opened from that checkpoint starts with them. The plane is the real one in process,
// over the in-memory stores. The first room starts with one range, read from the side object of
// the checkpoint at seq 0; nothing in the hosted service creates a range in a room yet (the control
// plane maps a thread's range on demand from the thread store), so a test seeds it this way.
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadAnchor } from '@docedit/authority';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { decodeSide, encodeSide } from '../../src/storage/codec.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from './client.ts';
import { MemoryCheckpoints, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

const anchor = (from: number, to: number): ThreadAnchor => ({
  id: 'tComment00000001',
  author: 'alice',
  target: { range: { from, to } },
  seq: 0,
  detached: false,
});

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const sideAt = async (cp: MemoryCheckpoints, p: Plane, doc: string, seq: number) => {
  const bytes = await cp.getSide(p.ref(doc), seq);
  return bytes ? decodeSide(bytes) : null;
};

describe('a checkpoint is written with the comment ranges (SYN-032 criterion 6)', () => {
  it('saves the ranges mapped to the checkpoint, and a room opened from it starts with them', async () => {
    const mem = new MemoryStore();
    const checkpoints = new MemoryCheckpoints();
    const p = await startPlane({
      stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
      checkpoints,
      settings: {
        roomIdleMs: 100,
        checkpoint: { everyCommits: 2000, everyMs: 600_000, minIntervalMs: 0 },
      },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const at = intro();
    // The range covers the first five characters of the introduction, at seq 0.
    await checkpoints.putSide(p.ref(doc), 0, encodeSide({ seq: 0, threads: [anchor(at, at + 5)] }));

    // Text typed before the range moves it; the idle close writes the checkpoint at seq 1.
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await alice.submit(1, { base: 0, steps: [insertText(at, 'abc')] })).t).toBe('sync.ack');
    alice.terminate();
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the idle room to close');
    const first = await sideAt(checkpoints, p, doc, 1);
    expect(first?.seq).toBe(1);
    expect(first?.threads).toEqual([{ ...anchor(at + 3, at + 8), seq: 1 }]);

    // A new room opens from that checkpoint with the range, maps it through a second commit, and
    // saves it again at seq 2.
    const again = await p.client('alice', { [doc]: 'owner' });
    expect((await again.open(1, doc)).t).toBe('ch.opened');
    expect((await again.submit(1, { base: 1, steps: [insertText(at, 'xyz')] })).t).toBe('sync.ack');
    again.terminate();
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the second room to close');
    const second = await sideAt(checkpoints, p, doc, 2);
    expect(second?.threads).toEqual([{ ...anchor(at + 6, at + 11), seq: 2 }]);
    // The checkpoint at seq 1 keeps its own ranges: they are kept for every checkpoint.
    expect((await sideAt(checkpoints, p, doc, 1))?.threads[0]?.target).toEqual({
      range: { from: at + 3, to: at + 8 },
    });
    expect(p.errors).toEqual([]);
  }, 30_000);

  it('writes no side object when the room holds no ranges', async () => {
    const mem = new MemoryStore();
    const checkpoints = new MemoryCheckpoints();
    const p = await startPlane({
      stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
      checkpoints,
      settings: {
        roomIdleMs: 100,
        checkpoint: { everyCommits: 2000, everyMs: 600_000, minIntervalMs: 0 },
      },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'abc')] })).t).toBe(
      'sync.ack',
    );
    alice.terminate();
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the idle room to close');
    expect(checkpoints.sides.size).toBe(0);
    expect(p.errors).toEqual([]);
  }, 30_000);
});
