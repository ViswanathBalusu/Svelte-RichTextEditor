/**
 * How an assistant's approved result enters the document (UX-046 criteria 1, 4, 5 and 6; 13 §6.2;
 * 07 §5.2 P4; 04 origins).
 *
 * - `assistantInsertion` always makes the result a suggestion, even for an editor (criterion 1). It
 *   is refused when the target scope gives the user no `suggest` (criterion 4): nothing is applied and
 *   the reason is returned for the author to see.
 * - `agentCaps` is the cap of 13 §6.2 as the UI computes it for display: the agent's capabilities are
 *   the user's capabilities intersected with `{suggest}` (UX-044 A3), so they never exceed the user's
 *   (criterion 5). The server enforces the cap; this function does not.
 * - `assistantOrigin` names the commit origin: `assistant` for the insertion itself and
 *   `suggestion.accept` for an editor who accepts it later (criterion 6, the review label names the
 *   model and the person it acted for).
 *
 * Building block only: nothing in the editor calls these functions yet, and the commit, the server's
 * check of the agent identity (UX-044 A1) and the authority rejection (criterion 3) are not built here.
 * No criterion of UX-046 is claimed by this module alone.
 */
import type { Capability } from '../core-api.ts';
import { ACCEPT_ORIGIN } from '../shell/review-rules.ts';

/** An approved result from the assistant port (what the author chose to insert). */
export interface AssistantResult {
  readonly text: string;
  /** The model that wrote the text, as the port names it. */
  readonly model: string;
  /** The person the assistant acted for. */
  readonly actingFor: string;
  /** The agent identity the server issued for this assistant (UX-044 A2). */
  readonly agent: string;
}

export type InsertDecision =
  | {
      readonly kind: 'suggestion';
      readonly origin: 'assistant';
      readonly agent: string;
      readonly model: string;
      readonly actingFor: string;
      readonly text: string;
    }
  | { readonly kind: 'refused'; readonly reason: 'no-suggest' };

/**
 * The decision for an approved result in a scope where the author holds `caps`. A result never
 * arrives as a direct edit (criterion 1); it is refused where there is no `suggest` (criterion 4).
 */
export function assistantInsertion(
  result: AssistantResult,
  caps: readonly Capability[],
): InsertDecision {
  if (!caps.includes('suggest')) return { kind: 'refused', reason: 'no-suggest' };
  return {
    kind: 'suggestion',
    origin: 'assistant',
    agent: result.agent,
    model: result.model,
    actingFor: result.actingFor,
    text: result.text,
  };
}

/** The agent's capabilities for a user who holds `userCaps`: `suggest` at most (UX-044 A3). */
export function agentCaps(userCaps: readonly Capability[]): readonly Capability[] {
  return userCaps.includes('suggest') ? ['suggest'] : [];
}

/** The label the review pane shows for an assistant suggestion (criterion 6). */
export function assistantReviewLabel(
  decision: Extract<InsertDecision, { kind: 'suggestion' }>,
): string {
  return `Suggested by ${decision.model} for ${decision.actingFor}`;
}

/** The commit origin of an editor accepting a suggestion (08 §14). */
export function assistantOrigin(step: 'insert' | 'accept'): 'assistant' | typeof ACCEPT_ORIGIN {
  return step === 'insert' ? 'assistant' : ACCEPT_ORIGIN;
}
