// BE-022 criterion 3 (lane V-BE-015-028): a commit that waits for a write (queued behind the write in
// flight, on another channel: one commit per channel may be in flight) is written and answered before
// the node releases the room's ownership when it drains. The plane is the real one in process, over
// the in-memory stores, with held log writes (GatedLogStore).
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { DocRef, OwnershipStore } from '../../src/storage/types.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from './client.ts';
import { GatedLogStore, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('drain writes and answers queued commits before releasing ownership (BE-022 criterion 3)', () => {
  it('stores and answers a commit that waited behind the write in flight, then releases', async () => {
    const mem = new MemoryStore();
    const gated = new GatedLogStore(mem);
    const releases: Array<{ epoch: number; released: boolean }> = [];
    const ownership: OwnershipStore = {
      claim: (ref, node) => mem.claim(ref, node),
      release: async (ref, node, epoch) => {
        const released = await mem.release(ref, node, epoch);
        releases.push({ epoch, released });
        return released;
      },
    };
    const p = await startPlane({
      stores: { logs: gated, ownership, grants: mem, documents: mem },
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const ref: DocRef = { tenant: p.tenant, doc };
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect((await bob.open(1, doc)).t).toBe('ch.opened');

    // Alice's commit is in flight, held in the log store; Bob's waits behind it in the room.
    gated.hold = true;
    const first = alice.submit(1, { base: 0, steps: [insertText(intro(), 'in flight')] });
    await until(() => gated.pending === 1, 3000, 'the first write to reach the store');
    const second = bob.submit(1, { base: 0, steps: [insertText(intro(), 'queued')] });
    // Let Bob's commit reach the room and wait behind the held write before the drain starts.
    await new Promise((r) => setTimeout(r, 100));

    const drained = p.plane.drain();

    // Releasing the first write stores it; the queued commit then goes to the store as the next write.
    await gated.release();
    await until(() => gated.pending === 1, 3000, 'the queued write to reach the store');
    // Ownership is not released while the queued write is still waiting.
    await new Promise((r) => setTimeout(r, 50));
    expect(releases).toHaveLength(0);
    expect((await mem.head(ref)).seq).toBe(1);

    await gated.release();
    expect((await first).t).toBe('sync.ack');
    expect((await second).t).toBe('sync.ack');
    await drained;

    // Both commits are stored, and only then is ownership released.
    expect((await mem.head(ref)).seq).toBe(2);
    expect(releases).toEqual([{ epoch: 1, released: true }]);
    expect(p.errors).toEqual([]);
  });
});
