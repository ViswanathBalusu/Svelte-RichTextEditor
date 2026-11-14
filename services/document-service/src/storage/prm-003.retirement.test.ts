/**
 * PRM-003 criteria 1 and 2 at the storage level (07 §3; I3): a commit that removes a region retires
 * its grants, state and lease in the same write as the log insert, and a write that fails part-way
 * leaves all of them in place and stores nothing. Memory storage: the PostgreSQL run is
 * test/postgres/prm-003-retirement.pg.test.ts, and the room's recovery after the failure is
 * src/data-plane/prm-003.recovery.test.ts. The retiring `seq` is read with `retiredSeqs`.
 */
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory.ts';
import type { DocRef } from './types.ts';

const TENANT = '0190f0a0-0000-7000-8000-00000000f003';
const GONE = 'rGone0000000001';
const KEPT = 'rKept0000000002';

function commit(seq: number, retired: string[] = [GONE]): StoredCommit {
  return {
    seq,
    kind: 'steps',
    id: uuid7(),
    user: 'owner',
    session: 's1',
    time: 1_760_000_000_000 + seq,
    origin: 'input',
    scopes: ['body', `region:${GONE}`],
    steps: [],
    retired,
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
    createdBy: 'owner',
    permissions: {
      revision: 1,
      grants: [
        { region: GONE, principal: 'user:bob', role: 'editor', expiresAt: null },
        { region: KEPT, principal: 'user:bob', role: 'editor', expiresAt: null },
      ],
      regionStates: new Map([[GONE, 'approved']]),
      leases: [{ region: GONE, holder: 'carol', expiresAt: 1_900_000_000_000 }],
      documentState: 'active',
      workflowActive: false,
    },
  });
  const ref = { tenant: TENANT, doc: doc.id };
  const epoch = await store.claim(ref, 'node-prm-003');
  return { store, ref, epoch };
}

describe('retiring a region removes its permission data in the log write (PRM-003 criterion 1)', () => {
  it('retires the grants, state and lease of the region together with the log write', async () => {
    const { store, ref, epoch } = await setUp();
    const before = await store.current(ref);
    expect(before.grants.some((g) => g.region === GONE)).toBe(true);
    expect(before.regionStates.has(GONE)).toBe(true);
    expect(before.leases.some((l) => l.region === GONE)).toBe(true);

    expect((await store.append(ref, request([commit(1)], epoch))).status).toBe('ok');

    const after = await store.current(ref);
    expect(after.grants.some((g) => g.region === GONE)).toBe(false);
    expect(after.regionStates.has(GONE)).toBe(false);
    expect(after.leases.some((l) => l.region === GONE)).toBe(false);
    // Nothing of another region goes with it.
    expect(after.grants.some((g) => g.region === KEPT)).toBe(true);
    expect(await store.retired(ref)).toEqual([GONE]);
    // The identifier is recorded with the retiring `seq`.
    expect(await store.retiredSeqs(ref)).toEqual(new Map([[GONE, 1]]));
  });

  it('records the seq of the commit that retires the region, not that of the batch start', async () => {
    const { store, ref, epoch } = await setUp();
    const batch = [commit(1, []), commit(2, [GONE])];
    expect((await store.append(ref, request(batch, epoch))).status).toBe('ok');
    expect(await store.retiredSeqs(ref)).toEqual(new Map([[GONE, 2]]));
  });
});

describe('a failed retirement leaves the region as it was (PRM-003 criterion 2)', () => {
  it('keeps grants, state and lease, and stores nothing, when the write fails after the insert', async () => {
    const { store, ref, epoch } = await setUp();
    const before = await store.current(ref);
    const headBefore = await store.state(ref);

    const failed = await store.append(ref, request([commit(1)], epoch), { fault: 'after-insert' });
    expect(failed).toEqual({ status: 'failed' });

    expect(await store.current(ref)).toEqual(before);
    expect((await store.state(ref)).seq).toBe(headBefore.seq);
    expect(await store.read(ref)).toEqual([]);
    expect(await store.retired(ref)).toEqual([]);
  });

  it('keeps everything when the write fails before the insert, and the retry then retires the region', async () => {
    const { store, ref, epoch } = await setUp();
    const before = await store.current(ref);

    expect(
      await store.append(ref, request([commit(1)], epoch), { fault: 'before-insert' }),
    ).toEqual({ status: 'failed' });
    expect(await store.current(ref)).toEqual(before);
    expect(await store.retired(ref)).toEqual([]);

    expect((await store.append(ref, request([commit(1)], epoch))).status).toBe('ok');
    expect((await store.current(ref)).grants.some((g) => g.region === GONE)).toBe(false);
    expect(await store.retired(ref)).toEqual([GONE]);
  });
});
