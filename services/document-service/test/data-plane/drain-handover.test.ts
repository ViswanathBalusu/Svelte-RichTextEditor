// Drain on deploy (06 §2.2 step 5; BE-022). The data plane runs in process over the in-memory
// stores, with a held log write (GatedLogStore) to put a commit in flight while the node drains,
// a checkpoint spy and an ownership spy that records each release.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { DocRef, OwnershipStore } from '../../src/storage/types.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { DepClient, insertText } from './client.ts';
import { GatedLogStore, MemoryCheckpoints, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** Checkpoints that record the `seq` of every write. */
class SpyCheckpoints extends MemoryCheckpoints {
  readonly seqs: number[] = [];
  override async put(ref: DocRef, seq: number, content: Parameters<MemoryCheckpoints['put']>[2]) {
    this.seqs.push(seq);
    return super.put(ref, seq, content);
  }
}

interface Release {
  doc: string;
  node: string;
  epoch: number;
  released: boolean;
}

/** Ownership in memory, with each release recorded. */
function spyOwnership(mem: MemoryStore, releases: Release[]): OwnershipStore {
  return {
    claim: (ref, node) => mem.claim(ref, node),
    release: async (ref, node, epoch) => {
      const released = await mem.release(ref, node, epoch);
      releases.push({ doc: ref.doc, node, epoch, released });
      return released;
    },
  };
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('drain on deploy (BE-022)', () => {
  it('refuses new connections and new channels once the drain starts, and refuses new commits (criterion 1)', async () => {
    const mem = new MemoryStore();
    const gated = new GatedLogStore(mem);
    const p = await startPlane({
      stores: { logs: gated, ownership: mem, grants: mem, documents: mem },
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');

    // Hold a write so that the drain has to wait for it.
    gated.hold = true;
    const inFlight = alice.submit(1, { base: 0, steps: [insertText(intro(), 'in flight')] });
    await until(() => gated.pending === 1, 3000, 'the commit to reach the write');

    const drained = p.plane.drain();
    await expect(DepClient.connect(p.url)).rejects.toMatchObject({ status: 503 });
    // A channel for another document is refused while the drain waits for the write in flight.
    const other = await p.createDocument();
    const second = await alice.open(2, other);
    expect(second).toMatchObject({ t: 'ch.rejected', d: { code: 'unavailable' } });
    // A commit sent during the drain is never acknowledged; the write held before it is.
    const lateId = alice.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'late')] });

    await gated.release();
    expect((await inFlight).t).toBe('sync.ack');
    await drained;
    expect(alice.all('sync.ack').map((m) => m.re)).not.toContain(lateId);
    expect((await mem.head({ tenant: p.tenant, doc })).seq).toBe(1);
  });

  it('tells every connection to reconnect with a jittered hint and a reason, then closes it with 4503 (criterion 2)', async () => {
    const p = await startPlane({ node: 'node-a' });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    await alice.open(1, doc);
    await bob.open(1, doc);

    await p.plane.drain();
    for (const c of [alice, bob]) {
      const g = await c.take((m) => m.t === 'goaway');
      const hint = g.d!['reconnectInMs'] as number;
      expect(Number.isInteger(hint)).toBe(true);
      expect(hint).toBeGreaterThanOrEqual(1000);
      expect(hint).toBeLessThan(5000);
      expect(typeof g.d!['reason']).toBe('string');
      expect((await c.closed).code).toBe(4503);
    }
  });

  it('answers the write in flight, checkpoints the room with changes, and releases its ownership (criteria 3 and 4)', async () => {
    const mem = new MemoryStore();
    const gated = new GatedLogStore(mem);
    const checkpoints = new SpyCheckpoints();
    const releases: Release[] = [];
    const p = await startPlane({
      stores: {
        logs: gated,
        ownership: spyOwnership(mem, releases),
        grants: mem,
        documents: mem,
      },
      checkpoints,
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const ref: DocRef = { tenant: p.tenant, doc };
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    checkpoints.seqs.length = 0; // count only what the drain writes

    gated.hold = true;
    const inFlight = alice.submit(1, { base: 0, steps: [insertText(intro(), 'kept')] });
    await until(() => gated.pending === 1, 3000, 'the commit to reach the write');

    const drained = p.plane.drain();
    // Nothing is released while the write is still held.
    await new Promise((r) => setTimeout(r, 50));
    expect(releases).toHaveLength(0);
    expect(checkpoints.seqs).toHaveLength(0);

    await gated.release();
    const ack = await inFlight;
    expect(ack).toMatchObject({ t: 'sync.ack' });
    await drained;

    // The commit is stored, the room is checkpointed at its head, and ownership is released.
    expect((await mem.head(ref)).seq).toBe(1);
    expect(checkpoints.seqs).toEqual([1]);
    expect(releases).toEqual([{ doc, node: 'node-a', epoch: 1, released: true }]);
  });

  it('hands the room to another node after a drain, which then serves the stored commits (criterion 4, handover)', async () => {
    const mem = new MemoryStore();
    const checkpoints = new SpyCheckpoints();
    const releases: Release[] = [];
    const first = await startPlane({
      stores: { logs: mem, ownership: spyOwnership(mem, releases), grants: mem, documents: mem },
      checkpoints,
      node: 'node-a',
    });
    planes.push(first);
    const doc = await first.createDocument();
    const alice = await first.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    await alice.submit(1, { base: 0, steps: [insertText(intro(), 'before deploy')] });
    await first.plane.drain();
    expect(releases.every((r) => r.released)).toBe(true);

    // The next node takes the document with the next epoch, with no lease in its way.
    const second = await startPlane({
      stores: { logs: mem, ownership: mem, grants: mem, documents: mem },
      checkpoints,
      tenant: first.tenant,
      node: 'node-b',
    });
    planes.push(second);
    const bob = await second.client('bob', { [doc]: 'editor' });
    expect((await bob.open(1, doc)).t).toBe('ch.opened');
    expect((await mem.head({ tenant: first.tenant, doc })).seq).toBe(1);
    expect(second.errors).toEqual([]);
  });
});
