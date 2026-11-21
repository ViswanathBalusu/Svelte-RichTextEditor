// The tombstone of a commit whose payload has moved to a cold segment (HIS-040 with HIS-029), over
// fakes: the payload is taken out of the segment first and the tombstone is recorded after, the
// copies left are reported, and a service that cannot write segments refuses. The rows and the
// route are tested on PostgreSQL in test/postgres/his-040-tombstone.pg.test.ts and
// test/postgres/his-029-cold-removal.pg.test.ts.
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../data-plane/memory-ports.ts';
import { MemoryObjectStore, objectKeys } from '../objects/store.ts';
import type { CheckpointIndex, DocumentRecord } from '../storage/types.ts';
import {
  CommitTombstone,
  type CommitTombstoneDeps,
  type PayloadState,
  type TombstoneStore,
} from './commit-tombstone.ts';

const T = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 10, 20);

function setup(state: PayloadState, over: Partial<CommitTombstoneDeps> = {}) {
  const calls: string[] = [];
  const store: TombstoneStore = {
    state: async () => state,
    remove: async (_t, _d, seq) => void calls.push(`remove ${seq}`),
    record: async (_t, _d, seq) => void calls.push(`record ${seq}`),
  };
  const objects = new MemoryObjectStore();
  const audit = new MemoryAudit();
  const cold = {
    remove: async (_t: string, _d: string, seqs: readonly number[]) => {
      calls.push(`cold ${seqs.join(',')}`);
      return { removed: [...seqs], objects: [objectKeys.segment(T, D, 1, 4)] };
    },
  };
  const tombstone = new CommitTombstone({
    store,
    documents: { get: async () => ({ id: D }) as unknown as DocumentRecord },
    checkpoints: {
      list: async () => [{ seq: 4 }, { seq: 8 }],
    } as unknown as CheckpointIndex,
    objects,
    audit,
    held: async () => false,
    now: () => NOW,
    cold,
    ...over,
  });
  return { tombstone, calls, objects, audit, store };
}

describe('a tombstone on a commit in a cold segment (HIS-040, HIS-029)', () => {
  it('takes the payload out of its segment, then records the tombstone, and audits it', async () => {
    const s = setup('cold');
    // The segment the index names, and an object the index does not name that covers the commit.
    await s.objects.put(objectKeys.segment(T, D, 1, 4), new Uint8Array([1]));
    await s.objects.put(objectKeys.segment(T, D, 2, 3), new Uint8Array([1]));
    await s.objects.put(objectKeys.segment(T, D, 5, 6), new Uint8Array([1]));
    const r = await s.tombstone.tombstone(T, D, 3, 'system', 'must not be kept');
    expect(s.calls).toEqual(['cold 3', 'record 3']);
    expect(r).toMatchObject({ seq: 3, removedAt: new Date(NOW).toISOString() });
    expect(r.copies.checkpoints).toEqual([4, 8]);
    // The segment that was written again is not a copy any more; the other object may hold it.
    expect(r.copies.coldSegments).toEqual([objectKeys.segment(T, D, 2, 3)]);
    const events = await s.audit.query(T, { kind: 'commit.tombstoned', limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ doc: D, actor: 'system', data: { seq: 3 } });
  });

  it('records the tombstone all the same when the segment no longer held the payload', async () => {
    const calls: string[] = [];
    const s = setup('cold', {
      cold: {
        remove: async () => {
          calls.push('cold');
          return { removed: [], objects: [] };
        },
      },
    });
    await s.objects.put(objectKeys.segment(T, D, 1, 4), new Uint8Array([1]));
    const r = await s.tombstone.tombstone(T, D, 3, 'system', 'again');
    expect(calls).toEqual(['cold']);
    expect(s.calls).toEqual(['record 3']);
    // Nothing was written again, so the object that covers the commit is still reported.
    expect(r.copies.coldSegments).toEqual([objectKeys.segment(T, D, 1, 4)]);
  });

  it('records nothing when the payload cannot be taken out of its segment', async () => {
    const s = setup('cold', {
      cold: {
        remove: async () => {
          throw new Error('the segment cannot be read');
        },
      },
    });
    await expect(s.tombstone.tombstone(T, D, 3, 'system', 'reason')).rejects.toThrow(
      /cannot be read/,
    );
    expect(s.calls).toEqual([]);
    expect(await s.audit.query(T, { kind: 'commit.tombstoned', limit: 5 })).toEqual([]);
  });

  it('answers unavailable when the service cannot write cold segments', async () => {
    const s = setup('cold');
    const without = new CommitTombstone({
      store: s.store,
      documents: { get: async () => ({ id: D }) as unknown as DocumentRecord },
      checkpoints: { list: async () => [{ seq: 8 }] } as unknown as CheckpointIndex,
      objects: s.objects,
      audit: s.audit,
      held: async () => false,
      now: () => NOW,
    });
    await expect(without.tombstone(T, D, 3, 'system', 'reason')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(s.calls).toEqual([]);
  });

  it('deletes the payload row of a commit that is still in the table, as before', async () => {
    const s = setup('present');
    await s.tombstone.tombstone(T, D, 3, 'system', 'reason');
    expect(s.calls).toEqual(['remove 3']);
  });

  it('refuses a commit that is gone, one above every checkpoint, and a document under a hold', async () => {
    await expect(
      setup('removed').tombstone.tombstone(T, D, 3, 'system', 'reason'),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      setup('absent').tombstone.tombstone(T, D, 3, 'system', 'reason'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      setup('cold').tombstone.tombstone(T, D, 9, 'system', 'reason'),
    ).rejects.toMatchObject({ code: 'conflict' });
    const held = setup('cold', { held: async () => true });
    await expect(held.tombstone.tombstone(T, D, 3, 'system', 'reason')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(held.calls).toEqual([]);
  });
});
