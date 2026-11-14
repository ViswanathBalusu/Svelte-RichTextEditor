// The perm-region property's own pieces (PRO-113 criterion 4): the operations it builds on a
// document that an earlier accepted commit changed, and the failure it reports. Regression for the
// intermittent failure on the reference service: with property seed 3 (fast-check path "5") an
// owner's accepted `across` delete from the intro to the middle paragraph removed the open region,
// and building the next operation on the open paragraph threw "no node pOpen00000000001 in the
// document" (a kit defect; the service and the oracle agreed on every accepted commit).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KitFailure } from '../src/assert.ts';
import { IDS, contractDocument, paragraph, posIn, withBody } from '../src/documents.ts';
import { buildSteps, propertyFailure, type Op } from '../src/profiles/perm.ts';

/** The contract document after deleting from the start of the intro to the end of the middle paragraph. */
const afterAcross = () =>
  withBody([
    paragraph(IDS.intro, ''),
    {
      type: 'region',
      attrs: { id: IDS.locked, title: 'Locked', policy: 'restricted' },
      content: [paragraph(IDS.lockedPara, 'Restricted text')],
    },
    paragraph(IDS.end, ''),
  ]).doc;

/** The same document after a delete that also removed the restricted region. */
const noLocked = () => withBody([paragraph(IDS.intro, ''), paragraph(IDS.end, '')]).doc;

describe('buildSteps on a document an accepted commit changed', () => {
  it('skips an operation on a paragraph that no longer exists (seed 3 counterexample)', () => {
    const doc = afterAcross();
    const ops: Op[] = [
      { kind: 'delete', at: IDS.openPara, offset: 10, len: 4 },
      { kind: 'insert', at: IDS.openPara, offset: 0, text: 'x' },
      { kind: 'bold', at: IDS.mid, offset: 0, len: 2 },
      { kind: 'across', from: IDS.openPara, to: IDS.end },
      { kind: 'across', from: IDS.intro, to: IDS.mid },
    ];
    for (const op of ops) expect(buildSteps(doc, op), JSON.stringify(op)).toBeNull();
  });

  it('skips a policy change when the restricted region was removed', () => {
    expect(buildSteps(noLocked(), { kind: 'policy', value: 'inherit' })).toBeNull();
  });

  it('still builds the operations on the nodes that remain', () => {
    const doc = afterAcross();
    expect(buildSteps(doc, { kind: 'insert', at: IDS.lockedPara, offset: 5, text: '"&' })).toEqual([
      {
        stepType: 'replace',
        from: posIn(doc, IDS.lockedPara, 5),
        to: posIn(doc, IDS.lockedPara, 5),
        slice: { content: [{ type: 'text', text: '"&' }] },
      },
    ]);
    expect(buildSteps(doc, { kind: 'policy', value: 'inherit' })).toHaveLength(1);
    expect(
      buildSteps(contractDocument().doc, { kind: 'across', from: IDS.intro, to: IDS.mid }),
    ).toEqual([
      {
        stepType: 'replace',
        from: posIn(contractDocument().doc, IDS.intro),
        to: posIn(contractDocument().doc, IDS.mid, 7),
      },
    ]);
  });
});

describe('the failure of a property run', () => {
  const caught = (seed: number, thrown: () => never): unknown => {
    try {
      fc.assert(
        fc.property(fc.nat(), () => thrown()),
        { seed, numRuns: 5, endOnFailure: true },
      );
    } catch (e) {
      return e;
    }
    throw new Error('the property did not fail');
  };

  it('keeps the inner KitFailure whole and adds the replay parameters', () => {
    const inner = new KitFailure(
      'an accepted commit is outside the writable set of a owner (07 §5)',
      'x',
      {
        role: 'owner',
      },
    );
    const f = propertyFailure(
      caught(42, () => {
        throw inner;
      }),
      42,
    );
    expect(f).toBe(inner);
    expect(f.message).toMatch(
      /^an accepted commit is outside the writable set of a owner \(07 §5\) \(property \{ seed: 42, path: "0", endOnFailure: true \}\)$/,
    );
    expect(f.received).toBe('{"role":"owner"}');
  });

  it('names the inner error, the seed and the counterexample for any other error', () => {
    const f = propertyFailure(
      caught(7, () => {
        throw new Error('no node pOpen00000000001 in the document');
      }),
      7,
    );
    expect(f).toBeInstanceOf(KitFailure);
    expect(f.message).toContain('{ seed: 7, path: "0", endOnFailure: true }');
    expect(f.message).toContain('Error: no node pOpen00000000001 in the document');
    expect(f.received).toMatch(/^"\[\d+\]"$/);
  });

  it('falls back to the configured seed when the message has no replay line', () => {
    const f = propertyFailure(new Error('boom'), 11);
    expect(f.message).toBe('the property failed (property { seed: 11 }): boom');
  });
});
