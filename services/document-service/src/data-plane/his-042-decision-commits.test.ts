/**
 * HIS-042 criterion 1, the storing half: an accepted or rejected suggestion is an ordinary commit
 * with origin `suggestion.accept` or `suggestion.reject`, stored by the real data plane with the
 * user who decided (08 §14; 04 §3.1). The commit goes through the same path as any other: it is
 * acknowledged, it takes the next `seq`, and the log keeps its origin and its user. The history
 * list that shows it with the label is tested in test/control-plane/his-042-decisions.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a decision on a suggestion is an ordinary commit with its origin (HIS-042 criterion 1)', () => {
  it('stores an accept and a reject as commits of the deciding user, with the origin the client gave', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    const owner = await p.client('alice', { [doc]: 'owner' });
    await owner.open(1, doc);
    const typed = await owner.submit(1, { base: 0, steps: [insertText(intro(), 'a')] });
    const accepted = await owner.submit(1, {
      base: 1,
      steps: [insertText(intro(), 'b')],
      origin: 'suggestion.accept',
    });
    const rejected = await owner.submit(1, {
      base: 2,
      steps: [insertText(intro(), 'c')],
      origin: 'suggestion.reject',
    });
    for (const r of [typed, accepted, rejected]) expect(r.t).toBe('sync.ack');
    const log = await p.stores.logs.read(p.ref(doc), 1, 3);
    expect(log.map((c) => [c.seq, c.kind, c.origin])).toEqual([
      [1, 'steps', 'input'],
      [2, 'steps', 'suggestion.accept'],
      [3, 'steps', 'suggestion.reject'],
    ]);
    // The deciding user is the one stamped on the commit, the same as for typing.
    expect(new Set(log.map((c) => c.user)).size).toBe(1);
  });
});
