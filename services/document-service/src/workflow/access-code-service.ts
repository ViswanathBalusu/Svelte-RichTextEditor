/**
 * The access code of a participant (12 §6.1 `auth`, §7; FRW-039).
 *
 * - `registerAccessCode`: the host registers the code of a participant whose `auth.require` lists
 *   `access_code`. Only a salted hash is stored (`registerAccessCode` of the authority); the code is
 *   not kept, logged, returned or put in an event. A new registration replaces the old and clears
 *   the wrong-attempt counter. The host sends the code to the person itself (12 §6.3).
 * - `verifyAccessCode`: the participant submits the code. Each attempt is counted before the code is
 *   compared, and an attempt over the limit is refused with the time left (`rate_limited`,
 *   `retryAfterMs`), correct or not. A wrong code raises `auth_failed` and records a failed attempt
 *   in the evidence; a correct one records the verification in the evidence, stores `verifiedAt`
 *   for the participant in a transition of the workflow (so the room gives them fill and tells them
 *   with `perm.changed` and `wf.changed`) and clears the counter. Until then the participant's
 *   fields stay read-only (`fillActive`, `awaitingCode`).
 *
 * The evidence of an attempt holds the time, the result, the participant's session facts the route
 * has (the address and the `User-Agent` of the request, the `amr` of the token), and never the code.
 * Decisions: docs/adr/0393-w4-FRW-039-access-code.md (proposed).
 */
import {
  registerAccessCode as hashAccessCode,
  verifyAccessCode as checkAccessCode,
  type ParticipantKind,
} from '@docedit/authority';
import type { EventSink } from '../control-plane/events.ts';
import type { DocRef } from '../storage/types.ts';
import type { AccessCodeStore, AttemptPolicy } from './access-code-store.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import { raiseWorkflowEvents } from './raise-events.ts';
import { recordTransition, type TransitionDeps } from './transitions.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

/**
 * The limit on attempts: 5 in a window of 15 minutes for each participant. Design values of ADR
 * 0393 (proposed); 12 states no limit.
 */
export const DEFAULT_ATTEMPT_POLICY: AttemptPolicy = { maxAttempts: 5, windowMs: 15 * 60_000 };

export interface AccessCodeDeps extends TransitionDeps {
  readonly codes: AccessCodeStore;
  readonly evidence: EvidenceLedger;
  readonly events: EventSink;
  readonly policy?: AttemptPolicy;
}

/** What the route knows of the request: the connection's facts, never the client's say. */
export interface AttemptFacts {
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly amr: readonly string[] | null;
}

export type AccessCodeProblem =
  | { readonly code: 'not_found' }
  | { readonly code: 'not_required' }
  | { readonly code: 'invalid_state'; readonly state: string }
  | { readonly code: 'not_registered' }
  | { readonly code: 'wrong_code' }
  | { readonly code: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly code: 'conflict'; readonly state: string };

const requiresCode = (p: WorkflowResourceView['participants'][number]): boolean =>
  p.auth?.require?.includes('access_code') === true;

export async function registerParticipantCode(
  deps: Pick<AccessCodeDeps, 'workflows' | 'codes' | 'now'>,
  req: { ref: DocRef; participant: string; code: string },
): Promise<{ ok: true } | { ok: false; problem: AccessCodeProblem }> {
  const view = await deps.workflows.read(req.ref.tenant, req.ref.doc);
  if (view === null) return { ok: false, problem: { code: 'not_found' } };
  const who = view.participants.find((p) => p.id === req.participant);
  if (who === undefined) return { ok: false, problem: { code: 'not_found' } };
  if (!requiresCode(who)) return { ok: false, problem: { code: 'not_required' } };
  if (!['draft', 'sent', 'in_progress', 'correcting'].includes(view.state))
    return { ok: false, problem: { code: 'invalid_state', state: view.state } };
  await deps.codes.register(
    req.ref.tenant,
    req.ref.doc,
    req.participant,
    await hashAccessCode(req.code),
    deps.now(),
  );
  return { ok: true };
}

export async function verifyParticipantCode(
  deps: AccessCodeDeps,
  req: {
    ref: DocRef;
    actor: string;
    participant: string;
    code: string;
    facts: AttemptFacts;
  },
): Promise<
  { ok: true; resource: WorkflowResourceView } | { ok: false; problem: AccessCodeProblem }
> {
  const { ref, participant, facts } = req;
  const view = await deps.workflows.read(ref.tenant, ref.doc);
  if (view === null) return { ok: false, problem: { code: 'not_found' } };
  const who = view.participants.find((p) => p.id === participant);
  if (who === undefined) return { ok: false, problem: { code: 'not_found' } };
  if (!requiresCode(who)) return { ok: false, problem: { code: 'not_required' } };
  if (view.state !== 'sent' && view.state !== 'in_progress')
    return { ok: false, problem: { code: 'invalid_state', state: view.state } };
  // A participant who has verified does it once: a repeat changes nothing.
  if (who.verifiedAt !== undefined) return { ok: true, resource: view };

  const now = deps.now();
  const taken = await deps.codes.reserve(
    ref.tenant,
    ref.doc,
    participant,
    now,
    deps.policy ?? DEFAULT_ATTEMPT_POLICY,
  );
  if (taken.state === 'none') return { ok: false, problem: { code: 'not_registered' } };
  if (taken.state === 'limited')
    return { ok: false, problem: { code: 'rate_limited', retryAfterMs: taken.retryAfterMs } };

  const right = await checkAccessCode(req.code, taken.record);
  const evidence = (ok: boolean) =>
    deps.evidence.record(ref.tenant, {
      doc: ref.doc,
      participant,
      kind: who.kind as ParticipantKind,
      item: 'access_code',
      facts: {
        items: {
          accessCode: { ok, atMs: now },
          ...(facts.amr !== null ? { amr: [...facts.amr] } : {}),
        },
        ipAddress: facts.address,
        userAgent: facts.userAgent,
      },
    });
  if (!right) {
    await evidence(false);
    await raiseWorkflowEvents(deps, ref, view, null, [{ name: 'auth_failed', participant }]);
    return { ok: false, problem: { code: 'wrong_code' } };
  }

  await evidence(true);
  const moved = await recordTransition(deps, {
    ref,
    actor: req.actor,
    from: view,
    write: {
      to: view.state,
      participants: view.participants.map((p) =>
        p.id === participant ? { ...p, verifiedAt: new Date(now).toISOString() } : p,
      ),
    },
    note: { by: participant, cause: 'access_code_verified' },
  });
  if (!moved.ok)
    return {
      ok: false,
      problem:
        moved.problem.code === 'conflict'
          ? { code: 'conflict', state: moved.problem.state }
          : { code: 'not_found' },
    };
  await deps.codes.clear(ref.tenant, ref.doc, participant);
  return { ok: true, resource: moved.resource };
}
