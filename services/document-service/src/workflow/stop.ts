/**
 * Stopping a workflow (12 §6.2 `decline` and `void`; FRW-033). Both go through `recordTransition`,
 * so each is a lock stored under a new grants revision, a control commit, a stored state and a push
 * to the room. The lock of `declined` and `voided` keeps the document locked and lets nobody fill
 * (`lockFor`), and neither state has a way out (`lifecycle.ts`).
 *
 * - `recordDecline`: a participant who is not a `cc` declines while the workflow is `in_progress`.
 * - `recordVoid`: the owner voids a workflow that is `sent` or `in_progress`.
 *
 * Both need a reason, trimmed; a blank one is refused before anything is written. The reason is kept
 * in the audit entry of the transition with who stopped it, and nowhere else: the webhook that
 * follows names the workflow, the document and, for a decline, the participant, never the reason
 * (FRW-036 criterion 2). Every participant who has not completed is marked `closed`.
 *
 * The events are returned, not raised: the route that calls these functions has the request context
 * that `emit` needs. Decisions: docs/adr/0386-w4-FRW-033-decline-and-void.md (proposed).
 */
import {
  declineWorkflow,
  voidWorkflow,
  type ParticipantKind,
  type WorkflowRefusal,
} from '@docedit/authority';
import type { DocRef } from '../storage/types.ts';
import { anchorEvidence, type AnchorDeps } from './evidence-anchor.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import type { ProgressOutcome } from './progress.ts';
import { recordOf } from './record.ts';
import { recordTransition, type TransitionDeps } from './transitions.ts';

export type StopOutcome =
  | Extract<ProgressOutcome, { ok: true }>
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: 'not_found' }
        | { readonly code: 'forbidden' }
        | { readonly code: 'reason_required' }
        | { readonly code: 'invalid_state'; readonly state: string }
        | { readonly code: 'conflict'; readonly state: string; readonly rev: number };
    };

const refusal = (state: string, why: WorkflowRefusal): StopOutcome => ({
  ok: false,
  problem: why === 'invalid_state' ? { code: 'invalid_state', state } : { code: why },
});

export async function recordDecline(
  deps: TransitionDeps,
  req: { ref: DocRef; actor: string; participant: string; reason: string },
): Promise<StopOutcome> {
  const { ref, actor, participant } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const out = declineWorkflow(recordOf(current), participant, req.reason);
  if (!out.ok) return refusal(current.state, out.refusal);
  const moved = await recordTransition(deps, {
    ref,
    actor,
    from: current,
    write: {
      to: 'declined',
      participants: current.participants.map((p) =>
        p.state === 'completed' ? p : { ...p, state: 'closed' },
      ),
    },
    note: { by: participant, reason: out.record.end?.reason ?? null },
  });
  if (!moved.ok) return { ok: false, problem: moved.problem };
  return {
    ok: true,
    changed: true,
    resource: moved.resource,
    control: moved.control,
    raised: [{ name: 'participant_declined', participant }],
  };
}

/** The most UTF-8 bytes of a reason the evidence of a decline can hold (a row's data is 4096 bytes). */
export const DECLINE_REASON_BYTES = 3000;

/** What `recordDeclineEvidence` needs: the ledger, the outbox the anchor goes through and the clock. */
export interface DeclineEvidenceDeps extends AnchorDeps {
  readonly evidence: EvidenceLedger;
}

/**
 * The evidence of a decline (12 §7; FRW-033 criterion 1; ADR 0415, proposed): the time and the
 * reason, stored with the participant's other evidence under the tenant, and a control commit that
 * follows the decline and carries the salted hash of it (origin `decline`), never the reason itself.
 * The network identity is the participant's own request, so a decline made by the host's service
 * credential has none. Returns the `seq` of the anchor, or null when it is queued and not stored yet.
 */
export async function recordDeclineEvidence(
  deps: DeclineEvidenceDeps,
  req: {
    readonly ref: DocRef;
    readonly participant: string;
    readonly kind: ParticipantKind;
    /** The reason as recorded in the transition, already trimmed. */
    readonly reason: string;
    readonly facts: { readonly address: string | null; readonly userAgent: string | null };
  },
): Promise<{ readonly seq: number | null }> {
  const made = await deps.evidence.record(req.ref.tenant, {
    doc: req.ref.doc,
    participant: req.participant,
    kind: req.kind,
    item: 'declined',
    origin: 'decline',
    facts: {
      items: { declined: { atMs: deps.now(), reason: req.reason } },
      ipAddress: req.facts.address,
      userAgent: req.facts.userAgent,
    },
  });
  return anchorEvidence(deps, req.ref, { origin: 'decline', evidenceHash: made.hash });
}

export async function recordVoid(
  deps: TransitionDeps,
  req: { ref: DocRef; actor: string; reason: string },
): Promise<StopOutcome> {
  const { ref, actor } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const out = voidWorkflow(recordOf(current), { manage: true }, req.reason);
  if (!out.ok) return refusal(current.state, out.refusal);
  const moved = await recordTransition(deps, {
    ref,
    actor,
    from: current,
    write: {
      to: 'voided',
      participants: current.participants.map((p) =>
        p.state === 'completed' ? p : { ...p, state: 'closed' },
      ),
    },
    note: { by: null, reason: out.record.end?.reason ?? null },
  });
  if (!moved.ok) return { ok: false, problem: moved.problem };
  return {
    ok: true,
    changed: true,
    resource: moved.resource,
    control: moved.control,
    raised: [{ name: 'voided' }],
  };
}
