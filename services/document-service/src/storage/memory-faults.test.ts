/**
 * The write faults of the in-memory log (BE-079 criterion 3; `AppendOptions.fault`), at the points
 * PgLogStore has them: the conditions first, then `before-insert` (nothing inserted, so not even a
 * duplicate identifier is noticed), then the inserts (where a duplicate is found), then
 * `after-insert` (the inserts are undone). The PostgreSQL side needs a database and is not run here.
 */
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory.ts';
import type { DocRef } from './types.ts';

const TENANT = '0190f0a0-0000-7000-8000-00000000f001';

function commit(seq: number, id = uuid7()): StoredCommit {
  return {
    seq,
    kind: 'steps',
    id,
    user: 'alice',
    session: 's1',
    time: 1_700_000_000_000 + seq,
    origin: 'user',
    scopes: ['region:rIntro'],
    steps: [],
    retired: ['rGone'],
    claimed: [],
    revision: 1,
    cdm: 1,
    engine: 'test',
  };
}

const request = (commits: StoredCommit[], epoch: number): WriteRequest => ({
  epoch,
  fromSeq: commits[0]!.seq,
  revision: 1,
  commits,
});

async function setUp(): Promise<{ store: MemoryStore; ref: DocRef; epoch: number }> {
  const store = new MemoryStore();
  const doc = await store.create(TENANT, {
    cdmVersion: 1,
    createdBy: 'alice',
    permissions: {
      revision: 1,
      grants: [{ region: 'rGone', principal: 'user:bob', role: 'editor', expiresAt: null }],
      regionStates: new Map(),
      leases: [],
      documentState: 'active',
      workflowActive: false,
    },
  });
  const ref = { tenant: TENANT, doc: doc.id };
  const epoch = await store.claim(ref, 'node-a');
  return { store, ref, epoch };
}

describe('write faults of the in-memory log (BE-079)', () => {
  it('fails before the insert: nothing is stored, and a duplicate identifier is not even looked at', async () => {
    const { store, ref, epoch } = await setUp();
    const first = commit(1);
    expect((await store.append(ref, request([first], epoch))).status).toBe('ok');
    const before = await store.state(ref);

    // A new commit fails and leaves the log, the chain head and the grants as they were.
    const fresh = request([commit(2)], epoch);
    expect(await store.append(ref, fresh, { fault: 'before-insert' })).toEqual({
      status: 'failed',
    });
    expect(await store.state(ref)).toEqual(before);

    // The duplicate is found by the insert, which a fault before it never reaches.
    const dup = request([{ ...first, seq: 2 }], epoch);
    expect(await store.append(ref, dup, { fault: 'before-insert' })).toEqual({ status: 'failed' });
    expect((await store.append(ref, dup)).status).toBe('duplicate');
  });

  it('fails after the insert: the rows, the retired regions and the grants are undone; a duplicate is reported as such', async () => {
    const { store, ref, epoch } = await setUp();
    const before = await store.state(ref);
    const grantsBefore = await store.current(ref);

    expect(await store.append(ref, request([commit(1)], epoch), { fault: 'after-insert' })).toEqual(
      {
        status: 'failed',
      },
    );
    expect(await store.state(ref)).toEqual(before);
    expect(await store.read(ref)).toEqual([]);
    expect(await store.retired(ref)).toEqual([]);
    expect(await store.current(ref)).toEqual(grantsBefore);

    // The same write without the fault is stored and retires the region.
    const first = commit(1);
    expect((await store.append(ref, request([first], epoch))).status).toBe('ok');
    expect(await store.retired(ref)).toEqual(['rGone']);
    const stored = await store.state(ref);
    expect(stored.seq).toBe(1);
    expect(stored.chainHead).toMatch(/^[0-9a-f]{64}$/);

    // The insert finds the duplicate before the fault point is reached.
    const dup = request([{ ...first, seq: 2 }], epoch);
    expect((await store.append(ref, dup, { fault: 'after-insert' })).status).toBe('duplicate');
    expect(await store.state(ref)).toEqual(stored);
  });

  it('reports a condition that does not hold whatever the fault', async () => {
    const { store, ref, epoch } = await setUp();
    for (const fault of ['before-insert', 'after-insert'] as const) {
      expect((await store.append(ref, request([commit(1)], epoch + 1), { fault })).status).toBe(
        'fenced',
      );
      const stale: WriteRequest = { ...request([commit(1)], epoch), revision: 0 };
      expect((await store.append(ref, stale, { fault })).status).toBe('revision_moved');
    }
    expect((await store.state(ref)).seq).toBe(0);
  });

  it('gives a chain head that changes with every commit and is null before the first', async () => {
    const { store, ref, epoch } = await setUp();
    expect((await store.state(ref)).chainHead).toBeNull();
    const heads = new Set<string>();
    for (let seq = 1; seq <= 3; seq++) {
      await store.append(ref, request([commit(seq)], epoch));
      const h = (await store.state(ref)).chainHead;
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      heads.add(h!);
    }
    expect(heads.size).toBe(3);
  });
});
