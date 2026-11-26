/**
 * The call to the tenant's data-loss prevention hook before an export or a send (UX-086).
 *
 * One function for both paths, so that the outcome is the same for each. An allow lets the request
 * go on. A deny refuses it (403 `forbidden`) with the reason the hook gave. A hook that does not
 * answer in time, cannot be reached or answers in a shape the service does not know refuses it too
 * (503 `unavailable`): fail closed, owner decision 122 (docs/owner-decisions-2026-11-15.md). Each
 * refusal is audited as `policy_hook.refused` or `policy_hook.unanswered`, with the action, the
 * target and the reason or the cause. With no hook configured, nothing is asked.
 */
import { uuid7 } from '@docedit/model';
import type { HookAction } from './policy-hook.ts';
import type { Kit } from './kit.ts';
import type { Ctx } from './pipeline.ts';
import { ApiError } from './problems.ts';

/** What the hook is asked about, besides who asks (taken from the caller). */
export interface PolicyHookQuestion {
  document: string;
  action: HookAction;
  /** Where the export or the send goes, as the request names it. */
  target: string;
  /** The document's classification label, or null (UX-085). */
  classification: string | null;
}

/** Asks the hook. Returns when it allows; throws an `ApiError` when it denies or does not answer. */
export async function askPolicyHook(d: Kit['d'], ctx: Ctx, q: PolicyHookQuestion): Promise<void> {
  if (!d.policyHook) return;
  const outcome = await d.policyHook.ask({
    document: q.document,
    actor: ctx.caller.actor,
    action: q.action,
    target: q.target,
    classification: q.classification,
  });
  const refuse = async (kind: string, data: Record<string, unknown>): Promise<void> => {
    await d.audit?.record([
      {
        id: uuid7(),
        tenant: ctx.caller.tenant,
        doc: q.document,
        actor: ctx.caller.actor,
        kind,
        data: { action: q.action, target: q.target, ...data },
        at: d.now(),
      },
    ]);
  };
  if (outcome.kind === 'unanswered') {
    await refuse('policy_hook.unanswered', { cause: outcome.cause });
    throw new ApiError(
      'unavailable',
      `the data-loss prevention hook did not answer; the ${q.action} is not started`,
    );
  }
  if (!outcome.decision.allow) {
    await refuse('policy_hook.refused', { reason: outcome.decision.reason });
    throw new ApiError('forbidden', outcome.decision.reason);
  }
}
