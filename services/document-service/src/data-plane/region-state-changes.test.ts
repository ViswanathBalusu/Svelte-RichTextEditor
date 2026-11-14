/**
 * Permission changes caused by region states, leases and the region list (PRO-034 criteria 1, 2
 * and 4; 05 §5.5; 07 §4, §10, §11). An approval limits the region to `view` and `comment` on every
 * open connection; a lease adds its holder to `access.leases` and removes `edit` from the others,
 * and its end (release or expiry) sends a new `perm.changed`; a commit that deletes a region takes
 * it out of `scopes`. The real data plane runs over the in-memory stores (test/data-plane/support.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const TERMS = 'region:rTerms000000000A';
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

/** A document with alice (owner), bob (editor) and frank (viewer), each on channel 1. */
async function room(p: Plane) {
  const doc = await p.createDocument();
  const alice = await p.client('alice', { [doc]: 'owner' });
  const bob = await p.client('bob', { [doc]: 'editor' });
  const frank = await p.client('frank', { [doc]: 'viewer' });
  for (const c of [alice, bob, frank]) await c.open(1, doc);
  return { doc, alice, bob, frank };
}

/** The absolute span of a region in the fixture document, and a position inside its first text block. */
function regionSpan(rid: string): { from: number; to: number; inside: number } {
  const d = baseDoc();
  let found: { from: number; to: number; inside: number } | null = null;
  d.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'region' && node.attrs['id'] === rid) {
      let inside = -1;
      node.descendants((child, cpos) => {
        if (inside < 0 && child.isTextblock) inside = pos + 1 + cpos + 1;
        return inside < 0;
      });
      if (inside < 0) throw new Error(`region ${rid} has no text block`);
      found = { from: pos, to: pos + node.nodeSize, inside };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`no region ${rid} in the fixture`);
  return found;
}

describe('region states change what every connection may do (PRO-034 criterion 1)', () => {
  it('approving a region sends perm.changed to every connection, limited to view and comment', async () => {
    const p = await plane();
    const { doc, alice, bob, frank } = await room(p);
    await p.changeGrants(doc, {
      setRegionStates: [{ region: 'rTerms000000000A', state: 'approved' }],
    });
    for (const c of [alice, bob, frank]) {
      const pc = await c.take((m) => m.t === 'perm.changed');
      expect(pc.d!['scopes'][TERMS]).not.toContain('edit');
      expect(pc.d!['scopes'][TERMS]).not.toContain('suggest');
    }
    const forOwner = alice.all('perm.changed')[0]!;
    const forEditor = bob.all('perm.changed')[0]!;
    expect(forOwner.d!['scopes'][TERMS]).toEqual(['view', 'comment']);
    expect(forEditor.d!['scopes'][TERMS]).toEqual(['view', 'comment']);
  });

  it('a commit into an approved region is refused for an editor under the new access', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    const pc0 = await p.changeGrants(doc, {
      setRegionStates: [{ region: 'rTerms000000000A', state: 'approved' }],
    });
    expect(pc0).toBeDefined();
    const seen = await bob.take((m) => m.t === 'perm.changed');
    const ack = await bob.submit(1, {
      base: seen.d!['asOfSeq'],
      steps: [insertText(regionSpan('rTerms000000000A').inside, 'x')],
    });
    expect(ack.t).toBe('sync.reject');
    expect(ack.d).toMatchObject({ code: 'permission_denied', action: 'drop' });
  });
});

describe('leases change the access of the region (PRO-034 criterion 2)', () => {
  it('a lease adds its holder to access.leases and removes edit from the others', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    const expiresAt = Date.now() + 600_000;
    await p.changeGrants(doc, {
      putLeases: [{ region: NOTES_ID, holder: 'alice', expiresAt }],
    });
    const pc = await bob.take((m) => m.t === 'perm.changed');
    expect(pc.d!['leases']).toEqual({
      [NOTES]: { holder: 'host-alice', expiresAt: new Date(expiresAt).toISOString() },
    });
    expect(pc.d!['scopes'][NOTES]).not.toContain('edit');
  });

  it('releasing the lease sends a new perm.changed that gives edit back', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    await p.changeGrants(doc, {
      putLeases: [{ region: NOTES_ID, holder: 'alice', expiresAt: Date.now() + 600_000 }],
    });
    const held = await bob.take((m) => m.t === 'perm.changed');
    expect(held.d!['scopes'][NOTES]).not.toContain('edit');
    await p.changeGrants(doc, { removeLeases: [NOTES_ID] });
    const released = await bob.take((m) => m.t === 'perm.changed');
    expect(released.d!['leases']).toEqual({});
    expect(released.d!['scopes'][NOTES]).toContain('edit');
    expect(released.d!['rev']).toBeGreaterThan(held.d!['rev'] as number);
  });

  it('the end of a lease at its expiry sends perm.changed with no other event', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    await p.changeGrants(doc, {
      putLeases: [{ region: NOTES_ID, holder: 'alice', expiresAt: Date.now() + 1500 }],
    });
    const held = await bob.take((m) => m.t === 'perm.changed');
    expect(held.d!['scopes'][NOTES]).not.toContain('edit');
    const ended = await bob.take((m) => m.t === 'perm.changed', 5000);
    expect(ended.d!['leases']).toEqual({});
    expect(ended.d!['scopes'][NOTES]).toContain('edit');
    // Exactly one change after the lease was taken: the expiry, with no other event between.
    expect(bob.all('perm.changed')).toHaveLength(2);
  });
});

describe('a region deleted by a commit leaves the scopes (PRO-034 criterion 4)', () => {
  it('after a commit that deletes region R, perm.changed does not list region:R in scopes', async () => {
    const p = await plane();
    const { alice, bob } = await room(p);
    const span = regionSpan(NOTES_ID);
    const ack = await alice.submit(1, {
      base: 0,
      steps: [{ stepType: 'replace', from: span.from, to: span.to, slice: { content: [] } }],
    });
    expect(ack.t).toBe('sync.ack');
    const pc = await bob.take((m) => m.t === 'perm.changed');
    expect(pc.d!['asOfSeq']).toBeGreaterThanOrEqual(ack.d!['seq'] as number);
    expect(Object.keys(pc.d!['scopes'])).not.toContain(NOTES);
    expect(Object.keys(pc.d!['scopes'])).toContain(TERMS);
  });
});
