// Closing an idle room releases its ownership (BE-021 criterion 1; 06 §2.2 steps 3 and 4).
// The plane runs in process over the in-memory stores with a short idle delay. The ownership
// store is wrapped so that each release is recorded, and the checkpoints record each write.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import type { DocRef, OwnershipStore } from '../../src/storage/types.ts';
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

interface Release {
  doc: string;
  node: string;
  epoch: number;
  released: boolean;
}

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

describe('an idle room releases its ownership (BE-021 criterion 1)', () => {
  it('checkpoints a room with changes, releases its ownership and frees it once its last channel has been gone for roomIdleMs', async () => {
    const mem = new MemoryStore();
    const checkpoints = new SpyCheckpoints();
    const releases: Release[] = [];
    const p = await startPlane({
      stores: { logs: mem, ownership: spyOwnership(mem, releases), grants: mem, documents: mem },
      checkpoints,
      settings: {
        roomIdleMs: 100,
        checkpoint: { everyCommits: 2000, everyMs: 600_000, minIntervalMs: 0 },
      },
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'idle work')] });
    expect(ack.t).toBe('sync.ack');
    checkpoints.seqs.length = 0; // count only what the idle close writes

    alice.terminate();
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the idle room to close');

    // The room checkpointed its changes, then released ownership at epoch 1.
    expect(checkpoints.seqs).toEqual([1]);
    expect(releases).toEqual([{ doc, node: 'node-a', epoch: 1, released: true }]);
    expect(p.errors).toEqual([]);
  });

  it('releases nothing while a channel is still open, and does not close the room within the idle delay', async () => {
    const mem = new MemoryStore();
    const releases: Release[] = [];
    const p = await startPlane({
      stores: { logs: mem, ownership: spyOwnership(mem, releases), grants: mem, documents: mem },
      settings: { roomIdleMs: 100 },
      node: 'node-a',
    });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    await new Promise((r) => setTimeout(r, 300));
    expect(p.plane.host.rooms).toHaveLength(1);
    expect(releases).toEqual([]);
  });
});
