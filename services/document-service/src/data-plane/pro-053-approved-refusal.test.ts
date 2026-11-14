/**
 * PRO-053 criterion 6: an approved region refuses any commit that would change it, whatever the
 * author's role, until the state changes. The editor case is in region-state-changes.test.ts
 * (PRO-034); this file adds the owner (who holds `manage`) and the return to `in_review`.
 * The real data plane runs over the in-memory stores (test/data-plane/support.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';
import { baseDoc } from '../../../../packages/authority/test/fixtures.ts';

const TERMS_ID = 'rTerms000000000A';

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

/** The position inside the first text block of a region of the fixture document. */
function insideRegion(rid: string): number {
  const d = baseDoc();
  let inside = -1;
  d.descendants((node, pos) => {
    if (inside >= 0) return false;
    if (node.type.name === 'region' && node.attrs['id'] === rid) {
      node.descendants((child, cpos) => {
        if (inside < 0 && child.isTextblock) inside = pos + 1 + cpos + 1;
        return inside < 0;
      });
      return false;
    }
    return true;
  });
  if (inside < 0) throw new Error(`no text block in region ${rid}`);
  return inside;
}

describe('an approved region refuses every commit that would change it (PRO-053 criterion 6)', () => {
  it('refuses a commit by the owner, who holds manage, while the region is approved', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    await p.changeGrants(doc, {
      setRegionStates: [{ region: TERMS_ID, state: 'approved' }],
    });
    const seen = await alice.take((m) => m.t === 'perm.changed');
    const ack = await alice.submit(1, {
      base: seen.d!['asOfSeq'],
      steps: [insertText(insideRegion(TERMS_ID), 'x')],
    });
    expect(ack.t).toBe('sync.reject');
    expect(ack.d).toMatchObject({ code: 'permission_denied', action: 'drop' });
  });

  it('accepts the owner commit again once the region leaves approved', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    await p.changeGrants(doc, {
      setRegionStates: [{ region: TERMS_ID, state: 'approved' }],
    });
    await alice.take((m) => m.t === 'perm.changed');
    await p.changeGrants(doc, {
      setRegionStates: [{ region: TERMS_ID, state: 'in_review' }],
    });
    const seen = await alice.take((m) => m.t === 'perm.changed' && m.d!['rev'] !== undefined);
    const ack = await alice.submit(1, {
      base: seen.d!['asOfSeq'],
      steps: [insertText(insideRegion(TERMS_ID), 'x')],
    });
    expect(ack.t).toBe('sync.ack');
  });
});
