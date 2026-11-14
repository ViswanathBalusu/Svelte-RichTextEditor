/**
 * PRM-003 criterion 2 through the data plane (07 §3; I3; 06 §2.3, §8): a commit that removes a
 * region fails part-way in storage; the room recovers, both by serving on and by a restart from
 * storage on another node, and the region's grants, state and lease are all still in place and
 * the commit is not stored. The retry then retires them, with the retiring `seq` (criterion 1).
 *
 * The part-way failure is the test hook `failNextWrite(ref, 'after-insert')` (BE-079): the store
 * inserts the commit and undoes it before reporting `failed`. Storage is MemoryStore here; the
 * same failure inside a PostgreSQL transaction is test/postgres/prm-003-retirement.pg.test.ts.
 */
import type { PermissionState } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, basePermissions, posOf } from '../../../../packages/authority/test/fixtures.ts';
import type { Received } from '../../test/data-plane/client.ts';
import { MemoryCheckpoints, startPlane, type Plane } from '../../test/data-plane/support.ts';
import { MemoryStore } from '../storage/memory.ts';

const LEGAL = 'rLegal000000000B';
const SCOPE = `region:${LEGAL}`;

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** The fixture permissions plus a state and a lease on the region Legal. */
function permissions(): PermissionState {
  return {
    ...basePermissions(),
    regionStates: new Map([[LEGAL, 'draft']]),
    leases: [{ region: LEGAL, holder: 'alice', expiresAt: Date.now() + 3_600_000 }],
  };
}

/** The step that removes the region Legal as a whole. */
function removeLegal(): Record<string, unknown> {
  const doc = baseDoc();
  const at = posOf(doc, LEGAL);
  return { stepType: 'replace', from: at, to: at + doc.nodeAt(at)!.nodeSize };
}

/** The region's grants, state and lease as storage holds them. */
function regionData(p: PermissionState) {
  return {
    grants: p.grants.filter((g) => g.region === LEGAL).map((g) => g.principal),
    state: p.regionStates.get(LEGAL),
    lease: p.leases.find((l) => l.region === LEGAL)?.holder,
  };
}

const KEPT = { grants: ['group:legal', 'user:dave'], state: 'draft', lease: 'alice' };

/** Whether a `ch.opened` access names the region and its lease (leases are keyed by scope). */
function accessNamesLegal(opened: Received): boolean {
  const access = opened.d!['access'] as {
    scopes: Record<string, unknown>;
    leases: Record<string, unknown>;
  };
  return SCOPE in access.scopes && SCOPE in access.leases;
}

describe('a failed retirement leaves the region in place when the room recovers (PRM-003 criterion 2)', () => {
  it('keeps grants, state and lease and stores nothing; the room serves on, a restarted node reads the same, and the retry retires the region', async () => {
    const memory = new MemoryStore();
    const checkpoints = new MemoryCheckpoints();
    const tenant = crypto.randomUUID();
    const boot = async (node: string) => {
      const p = await startPlane({
        stores: { logs: memory, ownership: memory, grants: memory, documents: memory },
        checkpoints,
        tenant,
        node,
        settings: { testMode: true },
      });
      planes.push(p);
      return p;
    };

    const a = await boot('node-a');
    const doc = await a.createDocument({ perms: permissions() });
    const ref = a.ref(doc);
    expect(regionData(await memory.current(ref))).toEqual(KEPT);

    const alice = await a.client('alice', { [doc]: 'owner' });
    const first = await alice.open(1, doc);
    expect(first.t).toBe('ch.opened');
    expect(accessNamesLegal(first)).toBe(true);

    // The write of the removal fails after its inserts: the store undoes them and says `failed`.
    a.plane.hooks!.failNextWrite(ref, 'after-insert');
    const removal = uuid7();
    const failed = await alice.submit(1, { id: removal, base: 0, steps: [removeLegal()] });
    expect(failed.t).toBe('sync.reject');
    expect(failed.d).toMatchObject({ id: removal, code: 'unavailable', action: 'retry' });

    // Storage: the commit is not stored, and the region's permission data is all still there.
    expect(await memory.read(ref)).toEqual([]);
    expect((await memory.head(ref)).seq).toBe(0);
    expect(regionData(await memory.current(ref))).toEqual(KEPT);
    expect(await memory.retired(ref)).toEqual([]);

    // The room serves on: a new channel still finds the region, its state and its lease.
    const bob = await a.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    const servedOn = await bob.open(1, doc);
    expect(servedOn.t).toBe('ch.opened');
    expect(servedOn.d).toMatchObject({ head: 0 });
    expect(accessNamesLegal(servedOn)).toBe(true);

    // A crash and a restart on another node: the room is rebuilt from storage alone.
    expect(await a.plane.hooks!.killRoom(ref)).toBe(true);
    const b = await boot('node-b');
    const carol = await b.client('alice', { [doc]: 'owner' });
    const reopened = await carol.open(1, doc);
    expect(reopened.t).toBe('ch.opened');
    expect(reopened.d).toMatchObject({ head: 0 });
    expect(accessNamesLegal(reopened)).toBe(true);
    const content = await b.plane.readContent(b.tokens.identity(carol.token!), doc);
    expect(JSON.stringify(content.doc)).toContain(LEGAL);
    expect(regionData(await memory.current(ref))).toEqual(KEPT);

    // The client resubmits the same commit: now it is stored, and the region is retired with it.
    const retried = await carol.submit(1, { id: removal, base: 0, steps: [removeLegal()] });
    expect(retried.t).toBe('sync.ack');
    expect(retried.d).toMatchObject({ id: removal, seq: 1 });
    expect((await memory.read(ref)).map((c) => c.id)).toEqual([removal]);
    expect(regionData(await memory.current(ref))).toEqual({
      grants: [],
      state: undefined,
      lease: undefined,
    });
    expect(await memory.retiredSeqs(ref)).toEqual(new Map([[LEGAL, 1]]));
  });
});
