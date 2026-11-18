/**
 * Recording a workflow transition (12 §6.2, last paragraph; FRW-030; 04 §3.2; 07 §9, §14).
 *
 * Every transition goes through `recordTransition`, so each one is written the same way:
 *
 * 1. The lock of the new state (`lockFor`, FRW-029) is stored as a grants change: the document
 *    state and `workflowActive`. The change raises the grants revision and writes its audit entry
 *    (`grants.changed`, with the actor, the document and the server time) in one transaction. When
 *    the lock is already in force, no change is made.
 * 2. The room is told. It records the grants revision as a control commit with no steps, in the
 *    same total order as content commits (04 §3.2; 07 §9). The commit has a deterministic
 *    identifier, so a repeat cannot append it twice.
 * 3. The workflow row moves to the new state in one conditional write (`WorkflowResourceStore.transition`).
 *    A participant who is active after the transition and was not before gets `activatedAt`, the
 *    server time: the anchor of the reminders (FRW-034).
 * 4. A `workflow.transition` audit entry names the states and the revision, so a transition that
 *    changes no lock (`sent` to `in_progress`) is audited too.
 * 5. The commit that records the transition is read back, when a room is open to write it, so that
 *    the webhooks of the transition carry its `seq` and the chain head (FRW-030 criterion 5).
 *
 * Order and recovery: the lock is stored before the state moves. A process that stops between the two
 * leaves a locked document whose workflow is still in the old state; the caller repeats the
 * transition, step 1 finds the lock in force and makes no second change, and the control commit of
 * that revision is written once. Nothing is done twice. The two writes are not one database
 * transaction (the grants and the workflow rows are written by different stores); ADR 0382 records
 * this as a proposal.
 */
import { lockFor, type WorkflowStateName } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import type { RoomNotifier } from '../seams.ts';
import { recordOf } from './record.ts';
import type { AuditStore, DocRef, GrantStore, LogStore } from '../storage/types.ts';
import type {
  WorkflowResourceStore,
  WorkflowResourceView,
  WorkflowTransitionWrite,
} from './workflow-resource.ts';

export interface TransitionDeps {
  readonly workflows: WorkflowResourceStore;
  readonly grants: GrantStore;
  readonly logs: LogStore;
  readonly notifier: RoomNotifier;
  readonly audit?: AuditStore | undefined;
  readonly now: () => number;
  /** How long to wait for the room to record the control commit, ms. 0 does not wait. */
  readonly controlWaitMs?: number;
  /** A test seam: runs between the lock and the state write (a crash there). */
  readonly afterLock?: () => void | Promise<void>;
}

export interface TransitionRequest {
  readonly ref: DocRef;
  /** The surrogate of the person or service that makes the transition (BE-013). */
  readonly actor: string;
  /** The workflow as the caller read it; the transition applies only to that state and revision. */
  readonly from: WorkflowResourceView;
  readonly write: WorkflowTransitionWrite;
  /**
   * More for the audit entry of the transition, such as the reason a workflow was stopped and who
   * stopped it (FRW-033). It is kept in the audit trail only, never in a webhook.
   */
  readonly note?: Readonly<Record<string, string | number | null>>;
  /**
   * Write a grants revision, and so a control commit, even when the new state changes no lock (FRW-054:
   * `completed` to `finalised` keeps the lock, and the transition is still part of the chain, 12 §6.2).
   */
  readonly anchor?: boolean;
}

/** The commit that records the transition, when it could be read back. */
export interface ControlRecord {
  readonly seq: number;
  readonly chainHead: string;
}

export type TransitionOutcome =
  | {
      readonly ok: true;
      readonly resource: WorkflowResourceView;
      /** The grants revision the lock was stored under, or null when no lock changed. */
      readonly revision: number | null;
      /** The control commit of the transition; null when no room was open to write it in time. */
      readonly control: ControlRecord | null;
    }
  | {
      readonly ok: false;
      readonly problem: { readonly code: 'conflict'; readonly state: string; readonly rev: number };
    }
  | { readonly ok: false; readonly problem: { readonly code: 'not_found' } };

const POLL_MS = 15;

/**
 * The participants as a transition leaves them, with `activatedAt` set to `at` (ISO 8601 UTC) for
 * each one who is active now and was not before (FRW-034). Everything else is kept as written.
 */
function withActivation(
  before: WorkflowResourceView['participants'],
  after: WorkflowResourceView['participants'],
  at: string,
): WorkflowResourceView['participants'] {
  return after.map((p) => {
    const prior = before.find((b) => b.id === p.id);
    if (p.state !== 'active') return p;
    if (prior?.state === 'active')
      return { ...p, activatedAt: p.activatedAt ?? prior.activatedAt ?? at };
    return { ...p, activatedAt: at };
  });
}

/**
 * Reads the control commit of grants revision `revision` back from the log, waiting up to `waitMs`.
 * A room that is not open writes it when it next opens (07 §9), so null is not an error.
 */
async function controlCommitOf(
  logs: LogStore,
  ref: DocRef,
  revision: number,
  from: number,
  waitMs: number,
): Promise<ControlRecord | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = (await logs.read(ref, from)).find(
      (c) => c.kind === 'control' && c.revision === revision,
    );
    if (found !== undefined) {
      // The chain head as the log holds it now: the control commit's own hash unless a later commit
      // has been appended since (the webhook says "the chain head", not "the hash of the commit").
      const chainHead = (await logs.state?.(ref))?.chainHead ?? null;
      if (chainHead !== null) return { seq: found.seq, chainHead };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function recordTransition(
  deps: TransitionDeps,
  req: TransitionRequest,
): Promise<TransitionOutcome> {
  const { ref, actor, from, write, note, anchor } = req;
  const lock = lockFor(write.to as WorkflowStateName);
  if (lock === null || lock === undefined)
    throw new RangeError(
      `recordTransition: the lock of state ${write.to} is not decided (FRW-029)`,
    );

  // 1 and 2: the lock, stored under a new grants revision, and the room told of it.
  const before = await deps.grants.current(ref);
  const headBefore = (await deps.logs.head(ref)).seq;
  let revision: number | null = null;
  const change: { documentState?: typeof lock.documentState; workflowActive?: boolean } = {};
  if (before.documentState !== lock.documentState) change.documentState = lock.documentState;
  if (before.workflowActive !== lock.workflowActive) change.workflowActive = lock.workflowActive;
  if (Object.keys(change).length > 0 || anchor === true) {
    const after = await deps.grants.change(ref, change, {
      actor,
      ifRevision: before.revision,
    });
    revision = after.revision;
    // A notifier that pushes the workflow (FRW-035) is told once, after the state moves, with the
    // record and these permissions together: the room then sends `perm.changed` and `wf.changed` in
    // order, with the access the new record implies. Any other is told of the lock now.
    if (deps.notifier.workflowChanged === undefined) deps.notifier.permissionsChanged(ref, after);
  }
  await deps.afterLock?.();

  // 3: the state moves, in one conditional write.
  const moved = await deps.workflows.transition(
    ref.tenant,
    ref.doc,
    { state: from.state, rev: from.rev },
    write.participants === undefined
      ? write
      : {
          ...write,
          participants: withActivation(
            from.participants,
            write.participants,
            new Date(deps.now()).toISOString(),
          ),
        },
  );
  if (!moved.ok) {
    // The lock is stored but the state did not move: the room still learns of the lock.
    if (deps.notifier.workflowChanged !== undefined && revision !== null)
      deps.notifier.permissionsChanged(ref, await deps.grants.current(ref));
    return { ok: false, problem: moved.problem } as TransitionOutcome;
  }
  // FRW-035: the room learns of the new state and, in step with it, of the permission state.
  deps.notifier.workflowChanged?.(ref, recordOf(moved.resource), await deps.grants.current(ref));

  // 4: the audit entry of the transition itself.
  await deps.audit?.record([
    {
      id: uuid7(),
      tenant: ref.tenant,
      doc: ref.doc,
      actor,
      kind: 'workflow.transition',
      data: { from: from.state, to: write.to, rev: moved.resource.rev, ...note },
      at: deps.now(),
    },
  ]);

  // 5: the control commit, when a room is there to write it.
  const control =
    revision === null
      ? null
      : await controlCommitOf(deps.logs, ref, revision, headBefore + 1, deps.controlWaitMs ?? 0);
  return { ok: true, resource: moved.resource, revision, control };
}
