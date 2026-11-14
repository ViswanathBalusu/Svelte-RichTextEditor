/**
 * The findings state over text revisions (UX-041 criterion 3; 13 §6.1). Rule level only: the
 * decorations and the port are not built, so this does not claim the shown result.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  START_FINDINGS,
  arrive,
  typed,
  type Finding,
  type FindingsResult,
  type FindingsState,
} from '../src/proofing/ux-041-findings.ts';

const findingArb: fc.Arbitrary<Finding> = fc.record({
  id: fc.uuid(),
  kind: fc.constantFrom('spelling' as const, 'grammar' as const),
  start: fc.integer({ min: 0, max: 100 }),
  end: fc.integer({ min: 0, max: 100 }),
  suggestions: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
});

type Op = { readonly op: 'type' } | { readonly op: 'arrive'; readonly result: FindingsResult };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ op: 'type' }),
  fc
    .record({
      revision: fc.integer({ min: 0, max: 6 }),
      findings: fc.array(findingArb, { maxLength: 4 }),
    })
    .map((result): Op => ({ op: 'arrive', result })),
);

function run(ops: readonly Op[]): FindingsState[] {
  const states: FindingsState[] = [START_FINDINGS];
  let state = START_FINDINGS;
  for (const o of ops) {
    state = o.op === 'type' ? typed(state) : arrive(state, o.result);
    states.push(state);
  }
  return states;
}

describe('findings are kept only for the revision they were computed from (UX-041 criterion 3)', () => {
  it('clears the findings when the text changes', () => {
    const shown = arrive(START_FINDINGS, {
      revision: 0,
      findings: [{ id: 'f1', kind: 'spelling', start: 0, end: 4, suggestions: ['word'] }],
    });
    expect(shown.findings).toHaveLength(1);
    const after = typed(shown);
    expect(after.revision).toBe(1);
    expect(after.findings).toEqual([]);
  });

  it('drops a late result for an earlier revision and keeps the state as it was', () => {
    const edited = typed(typed(START_FINDINGS));
    const late = arrive(edited, {
      revision: 0,
      findings: [{ id: 'old', kind: 'grammar', start: 1, end: 2, suggestions: [] }],
    });
    expect(late).toBe(edited);
  });

  it('keeps a result that is for the current revision', () => {
    const edited = typed(START_FINDINGS);
    const fresh = arrive(edited, {
      revision: 1,
      findings: [{ id: 'new', kind: 'spelling', start: 0, end: 3, suggestions: ['cat'] }],
    });
    expect(fresh.findings.map((f) => f.id)).toEqual(['new']);
    expect(fresh.revision).toBe(1);
  });

  it('never shows a finding computed for another revision (property over operation sequences)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const states = run(ops);
        // Revisions only go up.
        for (let i = 1; i < states.length; i++) {
          expect(states[i]!.revision).toBeGreaterThanOrEqual(states[i - 1]!.revision);
        }
        // Replay: a shown finding always comes from the revision the state is at.
        let revision = 0;
        let shownFrom: { revision: number; ids: string[] } = { revision: 0, ids: [] };
        for (const o of ops) {
          if (o.op === 'type') {
            revision++;
            shownFrom = { revision, ids: [] };
          } else if (o.result.revision === revision) {
            shownFrom = { revision, ids: o.result.findings.map((f) => f.id) };
          }
        }
        const final = states[states.length - 1]!;
        expect(final.revision).toBe(revision);
        expect(final.findings.map((f) => f.id)).toEqual(shownFrom.ids);
      }),
    );
  });
});
