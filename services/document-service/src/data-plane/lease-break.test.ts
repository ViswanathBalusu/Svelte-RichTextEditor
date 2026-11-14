/**
 * A lease broken before its expiry (PRO-034 criterion 2, the `break` case; 05 §5.5; 07 §10). The
 * data plane has no separate break path: a manager's break reaches the room as the same grant
 * change as a release (`removeLeases`), so this test checks the observable result for a lease
 * held by one user and broken by another. Runs over the in-memory stores (test/data-plane/support.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const NOTES_ID = 'rNotes000000000C';
const NOTES = `region:${NOTES_ID}`;

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}

describe('a lease broken by a manager ends at once (PRO-034 criterion 2, break)', () => {
  it('breaking a lease held by another user sends a new perm.changed that gives edit back', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    for (const c of [alice, bob]) await c.open(1, doc);

    // Alice holds the lease for far longer than the test takes, so only the break can end it.
    await p.changeGrants(doc, {
      putLeases: [{ region: NOTES_ID, holder: 'alice', expiresAt: Date.now() + 600_000 }],
    });
    const held = await bob.take((m) => m.t === 'perm.changed');
    expect(held.d!['scopes'][NOTES]).not.toContain('edit');

    // The manager's break: the lease leaves the state and the next perm.changed is sent at once.
    await p.changeGrants(doc, { removeLeases: [NOTES_ID] });
    const broken = await bob.take((m) => m.t === 'perm.changed', 2000);
    expect(broken.d!['leases']).toEqual({});
    expect(broken.d!['scopes'][NOTES]).toContain('edit');
    expect(broken.d!['rev']).toBeGreaterThan(held.d!['rev'] as number);

    // The holder receives the same two changes: the lease starts, then the break ends it.
    const aliceHeld = await alice.take((m) => m.t === 'perm.changed');
    expect(aliceHeld.d!['leases']).toHaveProperty([NOTES]);
    const aliceEnd = await alice.take((m) => m.t === 'perm.changed', 2000);
    expect(aliceEnd.d!['leases']).toEqual({});
  });
});
