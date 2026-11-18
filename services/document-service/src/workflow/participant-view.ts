/**
 * The first view of a participant, from the connection (12 §6.3, §7; FRW-031, FRW-040). When a
 * channel opens for a token with `wfp`, the workflow binds the token to its participant
 * (`bindParticipant`, FRW-038). The first time that participant opens the document of a `sent` or
 * `in_progress` workflow, the view is stored (`recordFirstView`: the time, and the move from `sent`
 * to `in_progress`), the evidence of the view is recorded in the ledger, and `participant_viewed`
 * is raised. A repeated open, a token that binds to no one and a workflow that is not running do
 * nothing.
 *
 * Every fact comes from the connection or the server clock: the session of the connection, the
 * address of the socket and the `User-Agent` of the upgrade request (kept or dropped by the
 * tenant's capture setting, FRW-042), the `amr` the token carried, as given, and the time the
 * channel opened. No message of the client reaches this module. Only the items that apply to the
 * participant's kind are recorded (the ledger refuses the rest). Decisions: docs/adr/0392-w4-FRW-040-participant-evidence.md (proposed).
 */
import { bindParticipant, type ParticipantKind } from '@docedit/authority';
import type { EventSink } from '../control-plane/events.ts';
import type { ParticipantOpened } from '../seams.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import { recordFirstView } from './progress.ts';
import { raiseWorkflowEvents } from './raise-events.ts';
import { recordOf } from './record.ts';
import type { TransitionDeps } from './transitions.ts';

export interface ViewDeps extends TransitionDeps {
  readonly evidence: EvidenceLedger;
  readonly events: EventSink;
}

/** Whether a first view was recorded, and the evidence row it wrote. */
export type ViewOutcome =
  { readonly recorded: false } | { readonly recorded: true; readonly evidence: string };

export async function recordParticipantOpened(
  deps: ViewDeps,
  open: ParticipantOpened,
): Promise<ViewOutcome> {
  const ref = { tenant: open.tenant, doc: open.doc };
  const view = await deps.workflows.read(ref.tenant, ref.doc);
  if (view === null || (view.state !== 'sent' && view.state !== 'in_progress'))
    return { recorded: false };
  const bound = bindParticipant({ sub: open.sub, wfp: open.wfp }, recordOf(view));
  if (!bound.ok) return { recorded: false };
  const participant = bound.participant.id;
  const out = await recordFirstView(deps, { ref, actor: open.actor, participant });
  // A refusal, or a view that was recorded before, adds no evidence.
  if (!out.ok || !out.changed) return { recorded: false };
  const kind = bound.participant.kind as ParticipantKind;
  const items: Record<string, unknown> = { session: open.session, viewedAtMs: open.at };
  if (open.amr !== null) items['amr'] = [...open.amr];
  const row = await deps.evidence.record(ref.tenant, {
    doc: ref.doc,
    participant,
    kind,
    item: 'viewed',
    origin: 'rules',
    facts: { items, ipAddress: open.address, userAgent: open.userAgent },
  });
  await raiseWorkflowEvents(deps, ref, out.resource, out.control, out.raised);
  return { recorded: true, evidence: row.id };
}
