/**
 * The data of the workflow webhooks (12 §6.3, §10; FRW-036 criteria 2 and 4). Pure: the webhook
 * delivery (signing, egress, at-least-once retries) is the workflow service's and is not built here.
 *
 * - The event names are those of 12 §10, and the type of each event carries the `dep.workflow.`
 *   prefix (FRW-036 Notes: the prefix is applied to all of them).
 * - The data holds identifiers, the `seq` and the chain head, and nothing else. It is built field by
 *   field, so a contact detail or an IP address that the caller holds cannot reach the data (FRW-036
 *   criterion 2). The participant's `name` and `sub` of 12 §6.1 are never copied.
 * - Every participant event names the participant (`participant_activated` carries the workflow,
 *   document and participant identifiers, FRW-036 criterion 4), so that the host can invite the person
 *   and mint their token (FRW-038).
 */
import { SHA256_HEX_PATTERN } from '@docedit/model';

/** The workflow events of 12 §10, in the order of the spec. */
export const WORKFLOW_EVENTS = [
  'sent',
  'participant_activated',
  'participant_viewed',
  'field_completed',
  'participant_completed',
  'participant_declined',
  'auth_failed',
  'reminder_due',
  'corrected',
  'voided',
  'expired',
  'completed',
  'finalised',
] as const;

export type WorkflowEventName = (typeof WORKFLOW_EVENTS)[number];

/** The prefix of every workflow event's type (FRW-036 Notes). */
export const WORKFLOW_EVENT_PREFIX = 'dep.workflow.';

/** The events that concern one participant, so their data names the participant. */
const PARTICIPANT_EVENTS: ReadonlySet<WorkflowEventName> = new Set<WorkflowEventName>([
  'participant_activated',
  'participant_viewed',
  'field_completed',
  'participant_completed',
  'participant_declined',
  'auth_failed',
  'reminder_due',
]);

/** The identifiers and the commit position an event is raised with. */
export interface WorkflowEventContext {
  readonly workflow: string;
  readonly document: string;
  /** The `seq` of the control commit of the transition (FRW-030 criterion 5). */
  readonly seq: number;
  /** The chain head: a SHA-256 digest in 64 lower-case hex characters. */
  readonly chainHead: string;
  /** The participant identifier, required for the events of PARTICIPANT_EVENTS. */
  readonly participant?: string;
}

/** The only members of an event's data (FRW-036 criterion 2). */
export interface WorkflowEventData {
  readonly workflow: string;
  readonly document: string;
  readonly seq: number;
  readonly chainHead: string;
  readonly participant?: string;
}

export interface WorkflowEvent {
  readonly type: string;
  readonly data: WorkflowEventData;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255;

/**
 * The event of one transition. Throws a RangeError when an identifier, the `seq` or the chain head
 * is malformed, or when a participant event names no participant: such an event is never raised.
 */
export function workflowEvent(name: WorkflowEventName, ctx: WorkflowEventContext): WorkflowEvent {
  if (!(WORKFLOW_EVENTS as readonly string[]).includes(name))
    throw new RangeError(`workflowEvent: ${name} is not a workflow event`);
  if (!isId(ctx.workflow) || !isId(ctx.document))
    throw new RangeError('workflowEvent: the workflow and document identifiers are required');
  if (!Number.isSafeInteger(ctx.seq) || ctx.seq < 0)
    throw new RangeError('workflowEvent: seq is a non-negative integer');
  if (!new RegExp(SHA256_HEX_PATTERN).test(ctx.chainHead))
    throw new RangeError('workflowEvent: the chain head is a SHA-256 hex digest');
  const needsParticipant = PARTICIPANT_EVENTS.has(name);
  if (needsParticipant && !isId(ctx.participant))
    throw new RangeError(`workflowEvent: ${name} names a participant`);
  const data: WorkflowEventData = {
    workflow: ctx.workflow,
    document: ctx.document,
    seq: ctx.seq,
    chainHead: ctx.chainHead,
    ...(needsParticipant && isId(ctx.participant) ? { participant: ctx.participant } : {}),
  };
  return { type: `${WORKFLOW_EVENT_PREFIX}${name}`, data };
}
