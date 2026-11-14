/**
 * The modules registered with the outcome check in production (PRM-010): P4 (PRM-014) and P7
 * (FRW-008). A caller that passes no registry gets these; a caller that passes another registry
 * gets exactly that one, and every scope a missing module would have decided is refused.
 */
import { FILL_RULE } from './fill.ts';
import type { OutcomeRules } from './registry.ts';
import { SUGGESTION_RULE } from './suggestions.ts';

export const STANDARD_RULES: OutcomeRules = Object.freeze({
  suggest: SUGGESTION_RULE,
  fill: FILL_RULE,
});
