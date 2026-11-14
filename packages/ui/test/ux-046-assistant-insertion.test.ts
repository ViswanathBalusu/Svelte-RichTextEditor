/**
 * Assistant writes as suggestions (UX-046, building block). Criteria 1 (a result is a suggestion, never
 * a direct edit, even for an editor), 4 (no suggest in the target scope is refused), 5 (the agent's
 * capabilities never exceed the user's) and 6 (the review label names the model and the person) are
 * tested at function level. The commit, the server's check of the agent identity and the authority
 * rejection (criteria 2 and 3) are not built here. Nothing calls these functions yet, so no criterion
 * is ticked on these tests alone.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability } from '../src/core-api.ts';
import {
  agentCaps,
  assistantInsertion,
  assistantOrigin,
  assistantReviewLabel,
  type AssistantResult,
} from '../src/assistant/insertion.ts';

const capsArb = fc.subarray<Capability>([
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
]);

const resultArb: fc.Arbitrary<AssistantResult> = fc.record({
  text: fc.string({ maxLength: 30 }),
  model: fc.constantFrom('model-a', 'model-b'),
  actingFor: fc.constantFrom('person-1', 'person-2'),
  agent: fc.constantFrom('agent-1', 'agent-2'),
});

describe('UX-046 assistant writes as suggestions (building block)', () => {
  it('makes an approved result a suggestion for an editor, never a direct edit (criterion 1, property)', () => {
    fc.assert(
      fc.property(resultArb, capsArb, (result, caps) => {
        const decision = assistantInsertion(result, [...caps, 'edit', 'suggest']);
        expect(decision.kind).toBe('suggestion');
        if (decision.kind === 'suggestion') {
          expect(decision.origin).toBe('assistant');
          expect(decision.agent).toBe(result.agent);
          expect(decision.model).toBe(result.model);
          expect(decision.actingFor).toBe(result.actingFor);
        }
      }),
    );
  });

  it('refuses the result, with a reason, where the user has no suggest in the scope (criterion 4, property)', () => {
    fc.assert(
      fc.property(resultArb, capsArb, (result, caps) => {
        const noSuggest = caps.filter((c) => c !== 'suggest');
        expect(assistantInsertion(result, noSuggest)).toEqual({
          kind: 'refused',
          reason: 'no-suggest',
        });
      }),
    );
  });

  it('keeps the agent within suggest and within the user capabilities (criterion 5, property)', () => {
    fc.assert(
      fc.property(capsArb, (userCaps) => {
        const cap = agentCaps(userCaps);
        for (const c of cap) {
          expect(c).toBe('suggest');
          expect(userCaps).toContain(c);
        }
        expect(cap.length === 0).toBe(!userCaps.includes('suggest'));
      }),
    );
  });

  it('labels the suggestion with the model and the person it acted for, and records an accept as suggestion.accept (criterion 6)', () => {
    const decision = assistantInsertion(
      { text: 'x', model: 'model-a', actingFor: 'person-1', agent: 'agent-1' },
      ['suggest'],
    );
    expect(decision.kind).toBe('suggestion');
    if (decision.kind !== 'suggestion') return;
    expect(assistantReviewLabel(decision)).toBe('Suggested by model-a for person-1');
    expect(assistantOrigin('insert')).toBe('assistant');
    expect(assistantOrigin('accept')).toBe('suggestion.accept');
  });
});
