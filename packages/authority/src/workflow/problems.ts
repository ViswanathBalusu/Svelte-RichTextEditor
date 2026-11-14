/**
 * The problems a workflow service answers a refused transition with, in codes of the DEP registry
 * (05 §9; `spec/dep/dep-1.registry.json`). The pure functions of `send.ts`, `lifecycle.ts` and
 * `order.ts` name their refusals locally (`invalid_state`, `reason_required`, `checklist_failed`)
 * and name the checks of the send checklist (`required_field_unassigned`,
 * `role_without_participant`, `rules_invalid`); none of those is a registry code. This module maps
 * them. The mapping is a proposal recorded in docs/adr/0249-lane-FRW-027-039.md (decision 10):
 *
 * - `forbidden` stays `forbidden` (403);
 * - `invalid_state` is `conflict` (409): the request conflicts with the workflow's current state;
 * - `reason_required` is `validation_failed` (400): the request lacks a reason;
 * - a failed checklist is one problem whose `failures` list every failure of every check (FRW-027
 *   criterion 2). Each failure carries its own registry code: `pending_suggestions` for unresolved
 *   suggestions, `validation_failed` for the other three checks. The problem's code is
 *   `pending_suggestions` when that is the only failing check, and `validation_failed` otherwise.
 *
 * The HTTP status is the registry's for the code. Pure: the service turns the result into a
 * problem document (RFC 9457) with its `type`, `title` and instance.
 */
import type { Refusal } from './lifecycle.ts';
import type { SendProblem, SendResult } from './send.ts';

/** The registry codes a workflow refusal is answered with. */
export type WorkflowProblemCode =
  'forbidden' | 'conflict' | 'validation_failed' | 'pending_suggestions';

/** The registry's HTTP status of each code (05 §9). */
export const WORKFLOW_PROBLEM_STATUS: Readonly<Record<WorkflowProblemCode, number>> = {
  forbidden: 403,
  conflict: 409,
  validation_failed: 400,
  pending_suggestions: 409,
};

/** One failure of the send checklist as the problem lists it: the check, its code and its detail. */
export type ChecklistFailure = SendProblem & {
  /** The registry code of this failure. */
  readonly registryCode: 'validation_failed' | 'pending_suggestions';
};

export interface WorkflowProblem {
  readonly code: WorkflowProblemCode;
  readonly status: number;
  readonly detail: string;
  /** Every failure of the checklist; empty for any other refusal. */
  readonly failures: readonly ChecklistFailure[];
}

/** The registry code of one checklist failure. */
export function checklistFailureCode(p: SendProblem): ChecklistFailure['registryCode'] {
  return p.code === 'pending_suggestions' ? 'pending_suggestions' : 'validation_failed';
}

const DETAIL: Readonly<Record<Refusal, string>> = {
  forbidden: 'the caller may not make this transition',
  invalid_state: 'the workflow state does not allow this transition',
  reason_required: 'a reason is required',
};

const CODE: Readonly<Record<Refusal, WorkflowProblemCode>> = {
  forbidden: 'forbidden',
  invalid_state: 'conflict',
  reason_required: 'validation_failed',
};

function problem(
  code: WorkflowProblemCode,
  detail: string,
  failures: readonly ChecklistFailure[] = [],
): WorkflowProblem {
  return { code, status: WORKFLOW_PROBLEM_STATUS[code], detail, failures };
}

/** The problem for a refused open, decline, void or completion (lifecycle.ts, order.ts). */
export function transitionProblem(refusal: Refusal): WorkflowProblem {
  return problem(CODE[refusal], DETAIL[refusal]);
}

/** The problem for a refused send (send.ts). */
export function sendProblem(result: Extract<SendResult, { ok: false }>): WorkflowProblem {
  if (result.refusal !== 'checklist_failed') return transitionProblem(result.refusal);
  const failures = result.problems.map((p): ChecklistFailure => ({
    ...p,
    registryCode: checklistFailureCode(p),
  }));
  const onlySuggestions =
    failures.length > 0 && failures.every((f) => f.registryCode === 'pending_suggestions');
  return problem(
    onlySuggestions ? 'pending_suggestions' : 'validation_failed',
    `the send checklist failed: ${failures.map((f) => f.code).join(', ')}`,
    failures,
  );
}
