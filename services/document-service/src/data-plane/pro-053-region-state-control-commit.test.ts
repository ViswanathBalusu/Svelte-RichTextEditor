/**
 * PRO-053 criterion 1, the room's part: a region state that is set is stored as a control commit at
 * the new grants revision (07 §9, §11; 05 §6.2). The control plane's route
 * (`PUT /documents/{id}/regions/{rid}/state`) is tested for its answers and its event in
 * `test/control-plane/routes.content.test.ts`; this file checks what the room writes to the log
 * when the grants change, over the real data plane with the in-memory stores (lane V-PRO-052-068).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const TERMS = 'rTerms000000000A';

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

describe('a region state is stored as a control commit (PRO-053 criterion 1)', () => {
  it('each state change writes one control commit at the grants revision it made', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const ref = p.ref(doc);

    const controls = async () =>
      (await p.stores.logs.read(ref))
        .filter((c) => c.kind === 'control')
        .map((c) => ({ revision: c.revision }));

    expect(await controls()).toEqual([]);

    const first = await p.changeGrants(doc, {
      setRegionStates: [{ region: TERMS, state: 'in_review' }],
    });
    expect(first.regionStates.get(TERMS)).toBe('in_review');
    expect(await controls()).toEqual([{ revision: first.revision }]);

    const second = await p.changeGrants(doc, {
      setRegionStates: [{ region: TERMS, state: 'approved' }],
    });
    expect(second.revision).toBe(first.revision + 1);
    expect(await controls()).toEqual([{ revision: first.revision }, { revision: second.revision }]);
  });

  it('a change the room is not told about writes no control commit', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await p.changeGrants(doc, { setRegionStates: [{ region: TERMS, state: 'draft' }] }, false);
    const stored = await p.stores.logs.read(ref);
    expect(stored.some((c) => c.kind === 'control')).toBe(false);
  });
});
