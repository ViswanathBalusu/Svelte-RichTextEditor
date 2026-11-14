/**
 * A lease that lapses without a heartbeat is ended by the room, and every open connection gets a
 * `perm.changed` (PRO-053 criterion 4, the notice part; 07 §10; 05 §5.5; lane U-PRO-035-051). The
 * lease is put with a short expiry and nobody renews it, so only the room's expiry timer can end
 * it. The room runs with its expiry timers on (the data plane's default), over the in-memory stores.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const NOTES_ID = 'rNotes000000000C';
const NOTES = `region:${NOTES_ID}`;
const LEASE_MS = 800;

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

describe('a lease without heartbeats lapses and the room says so (PRO-053 criterion 4)', () => {
  it('sends perm.changed to every connection when the lease expires, and gives edit back', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    for (const c of [alice, bob]) await c.open(1, doc);

    const started = Date.now();
    await p.changeGrants(doc, {
      putLeases: [{ region: NOTES_ID, holder: 'alice', expiresAt: started + LEASE_MS }],
    });
    const held = await bob.take((m) => m.t === 'perm.changed', 2000);
    expect(held.d!['leases']).toHaveProperty([NOTES]);
    expect(held.d!['scopes'][NOTES]).not.toContain('edit');

    // Nobody heartbeats: the room's expiry timer ends the lease and sends the notice.
    const lapsed = await bob.take(
      (m) => m.t === 'perm.changed' && (m.d as { rev: number }).rev > (held.d!['rev'] as number),
      LEASE_MS * 5,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(LEASE_MS - 50);
    expect(lapsed.d!['leases']).toEqual({});
    expect(lapsed.d!['scopes'][NOTES]).toContain('edit');

    const aliceLapsed = await alice.take(
      (m) => m.t === 'perm.changed' && (m.d as { rev: number }).rev > (held.d!['rev'] as number),
      LEASE_MS * 5,
    );
    expect(aliceLapsed.d!['leases']).toEqual({});
  });
});
