/**
 * Raising workflow events from the service itself, with no request in hand (FRW-034, FRW-040): the
 * scheduled sweep and the first view of a participant. The routes raise theirs with the request
 * context (`raiseAll` in control-plane/workflow-routes.ts). Both give an event the workflow, the
 * document and, for a participant's, the participant; the `seq` and the chain head of the control
 * commit of the transition, or the head of the log when the transition wrote none (FRW-036); and
 * nothing else.
 */
import { workflowEvent } from '@docedit/authority';
import type { DepEvent, EventSink } from '../control-plane/events.ts';
import type { DocRef } from '../storage/types.ts';
import type { RaisedEvent } from './progress.ts';
import type { ControlRecord, TransitionDeps } from './transitions.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The `seq` and the chain head an event of this workflow carries, as `raiseAll` of the routes. */
export async function eventPosition(
  deps: Pick<TransitionDeps, 'logs'>,
  ref: DocRef,
  resource: WorkflowResourceView,
  control: ControlRecord | null,
): Promise<{ seq: number; chainHead: string }> {
  if (control !== null) return control;
  const head = await deps.logs.head(ref);
  const logged = (await deps.logs.state?.(ref))?.chainHead;
  const sent = resource.sentHash?.replace(/^sha256:/, '');
  const chainHead = [logged, sent].find((h) => h !== undefined && h !== null && SHA256_HEX.test(h));
  if (chainHead === undefined || chainHead === null)
    throw new RangeError('the workflow has no chain head to name in an event');
  return { seq: head.seq, chainHead };
}

export async function raiseWorkflowEvents(
  deps: Pick<TransitionDeps, 'logs' | 'now'> & { readonly events: EventSink },
  ref: DocRef,
  resource: WorkflowResourceView,
  control: ControlRecord | null,
  raised: readonly RaisedEvent[],
): Promise<void> {
  const at = await eventPosition(deps, ref, resource, control);
  for (const e of raised) {
    const event = workflowEvent(e.name, {
      workflow: resource.id,
      document: ref.doc,
      ...at,
      ...(e.participant !== undefined ? { participant: e.participant } : {}),
    });
    const out: DepEvent = {
      type: `${event.type}.v1`,
      tenant: ref.tenant,
      subject: ref.doc,
      data: { ...event.data },
      time: deps.now(),
    };
    deps.events.emit(out);
  }
}
