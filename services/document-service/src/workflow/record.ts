/**
 * The workflow record of the authority (`WorkflowRecord`) for a stored workflow resource
 * (FRW-035, FRW-031). The resource keeps one `state` word for each participant once the workflow
 * runs (`active`, `pending` or `completed`, docs/adr/0383, point 6); the record keeps a `completed`
 * flag, from which the authority derives who is active. A workflow that was stopped keeps no reason
 * in the resource, so `end` is null here; only the room's lock and status words use the record.
 */
import type { WorkflowRecord } from '@docedit/authority';
import type { WorkflowResourceView } from './workflow-resource.ts';

const STATES = new Set<string>([
  'draft',
  'sent',
  'in_progress',
  'correcting',
  'completed',
  'finalised',
  'voided',
  'declined',
  'expired',
]);

export function recordOf(view: WorkflowResourceView): WorkflowRecord {
  if (!STATES.has(view.state)) throw new RangeError(`unknown workflow state ${view.state}`);
  return {
    state: view.state as WorkflowRecord['state'],
    participants: view.participants.map((p) => ({
      id: p.id,
      roles: p.roles,
      kind: p.kind,
      order: p.order,
      completed: p.state === 'completed',
      ...(p.sub !== undefined ? { sub: p.sub } : {}),
    })),
    sentSeq: view.sentSeq,
    sentHash: view.sentHash,
    end: null,
  };
}
