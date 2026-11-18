/**
 * The checkpoint thinning job over a fake store (HIS-030; checkpoint-thinning.ts). The real rows,
 * the real replay and the scheduler are in test/postgres/his-030-checkpoint-thinning.pg.test.ts;
 * these cases show what the job does when a verification cannot be made, when a document is held,
 * and when an object cannot be deleted.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { MemoryObjectStore, objectKeys, type ObjectStore } from '../objects/store.ts';
import { DAY_MS } from './document-purge.ts';
import {
  CheckpointThinning,
  type CheckpointFacts,
  type CheckpointThinningStore,
} from './checkpoint-thinning.ts';

const NOW = Date.UTC(2026, 10, 18, 12);
const T = '0190c9d8-0000-7000-8000-0000000000a1';
const D1 = '0190c9d8-0000-7000-8000-0000000000d1';
const HELD = '0190c9d8-0000-7000-8000-0000000000d2';
const FREE = '0190c9d8-0000-7000-8000-0000000000d3';
const DAY = Math.floor((NOW - 60 * DAY_MS) / DAY_MS) * DAY_MS;

/** Three checkpoints on one day 60 days ago, and one young: seq 1 and 2 are due for the day. */
const FACTS: CheckpointFacts = {
  checkpoints: [
    { seq: 1, time: DAY + 1000 },
    { seq: 2, time: DAY + 2000 },
    { seq: 3, time: DAY + 3000 },
    { seq: 4, time: NOW - DAY_MS },
  ],
  versions: [],
  snapshots: [],
};

function fake(docs: Record<string, CheckpointFacts>) {
  const removed: Array<{ doc: string; seqs: number[] }> = [];
  const store: CheckpointThinningStore = {
    documents: async () => Object.keys(docs),
    facts: async (_t, doc) => docs[doc]!,
    remove: async (_t, doc, seqs) => {
      removed.push({ doc, seqs: [...seqs] });
      return seqs.length;
    },
  };
  return { store, removed };
}

async function withObjects(objects: ObjectStore, doc: string): Promise<void> {
  for (let seq = 1; seq <= 4; seq++) {
    await objects.put(objectKeys.checkpoint(T, doc, seq), new Uint8Array([seq]));
    await objects.put(objectKeys.checkpointSide(T, doc, seq), new Uint8Array([seq]));
  }
}

describe('the checkpoint thinning job (HIS-030)', () => {
  it('removes the rows and the objects, main and side, of the checkpoints the plan names, and audits it', async () => {
    const { store, removed } = fake({ [D1]: FACTS });
    const objects = new MemoryObjectStore();
    await withObjects(objects, D1);
    const audit = new MemoryAudit();
    const verified: number[] = [];
    const job = new CheckpointThinning({
      store,
      objects,
      audit,
      now: () => NOW,
      verify: async (_ref, seq) => {
        verified.push(seq);
        return true;
      },
    });
    const r = await job.run(T);
    expect(r.thinned).toEqual([{ doc: D1, removed: 2 }]);
    expect(removed).toEqual([{ doc: D1, seqs: [1, 2] }]);
    // Only the keeper that replaces older ones is verified: not the young checkpoint, not the others.
    expect(verified).toEqual([3]);
    for (const seq of [1, 2]) {
      expect(await objects.exists(objectKeys.checkpoint(T, D1, seq))).toBe(false);
      expect(await objects.exists(objectKeys.checkpointSide(T, D1, seq))).toBe(false);
    }
    for (const seq of [3, 4])
      expect(await objects.exists(objectKeys.checkpoint(T, D1, seq))).toBe(true);
    const events = await audit.query(T, { kind: 'checkpoints.thinned', limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      doc: D1,
      data: { removed: 2, kept: 2, held: 0, objectsLeft: 0 },
    });
  });

  it('holds the period back when the keeper cannot be verified, and tells the caller why', async () => {
    const { store, removed } = fake({ [D1]: FACTS });
    const errors: Array<{ seq: number; message: string }> = [];
    const job = new CheckpointThinning({
      store,
      objects: new MemoryObjectStore(),
      audit: new MemoryAudit(),
      now: () => NOW,
      verify: async () => {
        throw new Error('the log has a gap below 3');
      },
      onUnverifiable: (_ref, seq, e) => errors.push({ seq, message: (e as Error).message }),
    });
    const r = await job.run(T);
    expect(r.thinned).toEqual([]);
    expect(r.held).toBe(3);
    expect(removed).toEqual([]);
    expect(errors).toEqual([{ seq: 3, message: 'the log has a gap below 3' }]);
  });

  it('holds the period back when the keeper does not match a replay', async () => {
    const { store, removed } = fake({ [D1]: FACTS });
    const job = new CheckpointThinning({
      store,
      objects: new MemoryObjectStore(),
      audit: new MemoryAudit(),
      now: () => NOW,
      verify: async () => false,
    });
    expect((await job.run(T)).thinned).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('leaves a document under a legal hold alone, reading nothing of it', async () => {
    let read = 0;
    const { store } = fake({ [HELD]: FACTS, [FREE]: FACTS });
    const counting: CheckpointThinningStore = {
      ...store,
      facts: async (t, d) => {
        read += 1;
        return store.facts(t, d);
      },
    };
    const job = new CheckpointThinning({
      store: counting,
      objects: new MemoryObjectStore(),
      audit: new MemoryAudit(),
      now: () => NOW,
      verify: async () => true,
    });
    const r = await job.run(T, new Set([HELD]));
    expect(r.skipped).toEqual([{ doc: HELD, reason: 'legal-hold' }]);
    expect(r.thinned).toEqual([{ doc: FREE, removed: 2 }]);
    expect(read).toBe(1);
  });

  it('counts an object it could not delete, and still removes the rows', async () => {
    const { store } = fake({ [D1]: FACTS });
    const inner = new MemoryObjectStore();
    await withObjects(inner, D1);
    const flaky = Object.create(inner) as ObjectStore;
    flaky.delete = async (key: string) => {
      if (key === objectKeys.checkpoint(T, D1, 1)) throw new Error('unavailable');
      await inner.delete(key);
    };
    const audit = new MemoryAudit();
    const job = new CheckpointThinning({
      store,
      objects: flaky,
      audit,
      now: () => NOW,
      verify: async () => true,
    });
    const r = await job.run(T);
    expect(r.thinned).toEqual([{ doc: D1, removed: 2 }]);
    const events = await audit.query(T, { kind: 'checkpoints.thinned', limit: 5 });
    expect(events[0]?.data).toMatchObject({ objectsLeft: 1 });
  });

  it('does nothing for a document with a single checkpoint', async () => {
    const { store, removed } = fake({
      [D1]: { checkpoints: [{ seq: 1, time: DAY }], versions: [], snapshots: [] },
    });
    const job = new CheckpointThinning({
      store,
      objects: new MemoryObjectStore(),
      audit: new MemoryAudit(),
      now: () => NOW,
      verify: async () => true,
    });
    expect((await job.run(T)).thinned).toEqual([]);
    expect(removed).toEqual([]);
  });
});
