/**
 * The end of a participant's work through the embedding API (12 §10; 05 §8.1; FRW-071):
 * `completeFilling()`, `decline(reason)` and the event `de-workflow-complete`. The service follows
 * the participant's own status as the backend's workflow port reports it (`wf.changed`, which carries
 * the workflow state and the receiving participant's status, never another participant's) and calls
 * the participant's `/complete` and `/decline` endpoints through that port.
 *
 * - `completeFilling()` checks the participant is active, runs `validateFields()` first, and when
 *   anything fails moves focus to the first problem and resolves with the failures without calling
 *   the server. Otherwise it calls `/complete` and resolves with what the server answered. A refusal
 *   from the server rejects with the port's error.
 * - `decline(reason)` checks the participant is active and that a reason is given (not blank); only
 *   then does it call `/decline`.
 * - A participant who is not active is refused before anything else: the call rejects with a
 *   `FillActionError` whose `reason` says why (the participant's own status, or `no_status` when the
 *   port has not reported one, or `not_in_progress` when the workflow is not running).
 * - `de-workflow-complete` is raised once when the port reports the workflow `completed`.
 *
 * The port must report the current status to a listener when it is added, as `ch.opened` carries it
 * (decision D20), and then each change. No DOM: this runs in Node.js tests against a stand-in port.
 */
import type { WorkflowPort } from '@docedit/protocol';

/** The workflow port members the service uses. */
export interface FillActionsSource {
  readonly port: Partial<Pick<WorkflowPort, 'participant' | 'onChange'>>;
  readonly docId: string;
}

/** What the service needs of the editing core. */
export interface FillActionsCore {
  validateFields(): readonly FillFailure[];
  focusFieldByKey(key: string): boolean;
}

/** One field that failed `validateFields()`: its key and the problems of its entry. */
export interface FillFailure {
  readonly key: string;
  readonly id?: string | null;
  readonly problems: readonly unknown[];
}

export type FillActionReason =
  | 'no_workflow'
  | 'no_status'
  | 'not_in_progress'
  | 'reason_required'
  // The participant's own status when it is not `active`: `unverified`, `waiting`, `completed`, ...
  | (string & {});

/** The reason a call to `completeFilling` or `decline` was refused before the server was called. */
export class FillActionError extends Error {
  readonly reason: FillActionReason;
  constructor(reason: FillActionReason, message: string) {
    super(message);
    this.name = 'FillActionError';
    this.reason = reason;
  }
}

export type CompleteFillingOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly failures: readonly FillFailure[] };

export interface FillActions {
  completeFilling(): Promise<CompleteFillingOutcome>;
  decline(reason: string): Promise<unknown>;
  /** Stops following the workflow. */
  dispose(): void;
}

interface Status {
  readonly state: string;
  readonly participant?: { readonly id: string; readonly state: string } | undefined;
}

export function fillActionsService(
  core: FillActionsCore,
  source: () => FillActionsSource | null,
  onWorkflowComplete: () => void,
): FillActions {
  let status: Status | null = null;
  let raised = false;
  const apply = (next: Status): void => {
    status = next;
    if (next.state === 'completed' && !raised) {
      raised = true;
      onWorkflowComplete();
    }
  };
  const first = source();
  const stop = first?.port.onChange?.(first.docId, (s) => apply(s));

  /** The participant to act for, or the reason that the caller may not. */
  function active(): {
    readonly act: NonNullable<FillActionsSource['port']['participant']>;
    readonly docId: string;
    readonly participant: string;
  } {
    const current = source();
    const act = current?.port.participant;
    if (!current || !act)
      throw new FillActionError('no_workflow', 'this document has no workflow port');
    const participant = status?.participant;
    if (status === null || participant === undefined)
      throw new FillActionError('no_status', 'the server has not said who this participant is');
    if (status.state !== 'in_progress')
      throw new FillActionError('not_in_progress', `the workflow is ${status.state}`);
    if (participant.state !== 'active')
      throw new FillActionError(participant.state, `the participant is ${participant.state}`);
    return { act: act.bind(current.port), docId: current.docId, participant: participant.id };
  }

  return {
    async completeFilling() {
      const { act, docId, participant } = active();
      const failures = core.validateFields();
      if (failures.length > 0) {
        core.focusFieldByKey(failures[0]!.key);
        return { ok: false, failures };
      }
      const result = await act(docId, participant, 'complete');
      return { ok: true, result };
    },
    async decline(reason) {
      const { act, docId, participant } = active();
      const trimmed = typeof reason === 'string' ? reason.trim() : '';
      if (trimmed === '') throw new FillActionError('reason_required', 'a reason is required');
      return act(docId, participant, 'decline', {
        reason: trimmed,
      });
    },
    dispose() {
      stop?.();
    },
  };
}
