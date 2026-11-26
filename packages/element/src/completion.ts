/**
 * Finishing the participant's part for the shell (FRW-048; FRW-071; 12 §8.1 step 4): the Finish
 * control calls `complete()`, which is `completeFilling()` of the fill actions. The fields are
 * checked first, and when any fails focus goes to the first and nothing is sent; otherwise the
 * participant's `/complete` endpoint is called. The answer is a word the shell can say.
 *
 * No DOM: this runs in Node.js tests against a stand-in.
 */
import type { CompletionOutcome, CompletionService } from '@docedit/ui';
import { FillActionError, type FillActions } from './fill-actions.ts';

export function completionService(
  actions: Pick<FillActions, 'completeFilling'>,
): CompletionService {
  return {
    async complete(): Promise<CompletionOutcome> {
      try {
        const outcome = await actions.completeFilling();
        return outcome.ok
          ? { ok: true }
          : { ok: false, reason: 'invalid', count: outcome.failures.length };
      } catch (error) {
        return { ok: false, reason: error instanceof FillActionError ? 'not_active' : 'failed' };
      }
    },
  };
}
