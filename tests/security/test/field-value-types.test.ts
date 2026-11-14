/**
 * SEC-022 criterion 3 — a value of the wrong type for its field kind is `field_invalid`; any other
 * violation by a fill-only participant is `permission_denied` (12 §4.2 P7; 04 §5 step 6).
 *
 * The pipeline is the one the room runs: the outcome check (permissions) first, then the invariants
 * of the result (checkInvariants). A fill-only participant's commit that the outcome check accepts
 * can only change the value of its own form fields, so the invariants can refuse it only for the
 * value's type or size (I15), which is `field_invalid`.
 */
import {
  applySteps,
  checkInvariants,
  type Connection,
  outcomeCheck,
  STANDARD_RULES,
  type OutcomeInput,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import { AttrStep, type Step } from 'prosemirror-transform';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ERIN, FIELDS, accessOf, fieldsDoc, permissions } from './support/authority-fixtures.ts';

const ctx = { requires: ['fields'], retiredRegionIds: new Set<string>() };

function posOf(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/**
 * The pipeline: outcome check, then (when it accepts) the invariants of the result. A commit whose
 * steps do not apply to the document is not a commit at all, so it reports `not_applied`.
 */
function pipeline(before: Node, steps: Step[], user: Connection) {
  const applied = applySteps(before, steps);
  if (!applied.ok) return { code: 'not_applied', stage: 'apply' as const };
  const input: OutcomeInput = {
    before,
    after: applied.value.doc,
    user: user.sub,
    access: accessOf(user, before),
    perms: permissions(),
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    rules: STANDARD_RULES,
  };
  const outcome = outcomeCheck(input);
  if (!outcome.ok) return { code: outcome.code as string, stage: 'outcome' as const };
  const inv = checkInvariants(before, applied.value.doc, steps, applied.value.docs, ctx);
  if (!inv.ok) return { code: inv.code as string, stage: 'invariants' as const };
  return { code: 'ok', stage: 'accepted' as const };
}

const fill = (doc: Node, id: string, attr: string, value: unknown): Step[] => [
  new AttrStep(posOf(doc, id), attr, value),
];

describe('SEC-022 criterion 3: wrong value types are field_invalid, other violations permission_denied', () => {
  const doc = fieldsDoc();

  it('a string value of the right type is accepted (the control)', () => {
    expect(pipeline(doc, fill(doc, FIELDS.number, 'value', '1250.00'), ERIN)).toEqual({
      code: 'ok',
      stage: 'accepted',
    });
  });

  it('a value of the wrong JSON type for a number field is field_invalid, at the invariants', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.array(fc.integer(), { maxLength: 3 }),
          fc.dictionary(fc.string({ maxLength: 4 }), fc.integer(), { maxKeys: 2 }),
        ),
        (value) => {
          expect(pipeline(doc, fill(doc, FIELDS.number, 'value', value), ERIN)).toEqual({
            code: 'field_invalid',
            stage: 'invariants',
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every refusal of a fill-only participant is permission_denied, or field_invalid for a wrong value type', () => {
    const nodeIds = [
      FIELDS.number,
      FIELDS.legal,
      FIELDS.readOnly,
      FIELDS.signature,
      FIELDS.landlord,
    ];
    const attrNames = [
      'value',
      'key',
      'kind',
      'assignee',
      'required',
      'readOnly',
      'options',
      'width',
      'bogus',
    ];
    const valueArb = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer({ min: -50, max: 50 }),
      fc.boolean(),
      fc.constant(null),
    );
    const commitArb = fc.record({
      id: fc.constantFrom(...nodeIds),
      attr: fc.constantFrom(...attrNames),
      value: valueArb,
    });
    const seen = new Set<string>();
    fc.assert(
      fc.property(commitArb, ({ id, attr, value }) => {
        const r = pipeline(doc, fill(doc, id, attr, value), ERIN);
        if (r.code === 'ok' || r.stage === 'apply') return;
        seen.add(r.code);
        if (r.stage === 'outcome') expect(r.code).toBe('permission_denied');
        else expect(r.code).toBe('field_invalid');
      }),
      { numRuns: 300 },
    );
    // Both refusal paths were exercised, so the property has bite.
    expect(seen).toContain('permission_denied');
    expect(seen).toContain('field_invalid');
  });
});
