/**
 * The last step of finalisation (12 §6.2 `completed` to `finalised`, §8.2 step 4; FRW-054
 * criterion 2). The sealed bytes come from the signing service (FRW-052, FRW-053), which is not
 * built here; this function takes them as input and does what follows a successful seal:
 *
 * 1. The workflow must be `completed`; any other state is refused and nothing is stored.
 * 2. The bytes are stored write-once and their hash recorded (`SealedPdfStore`).
 * 3. The gate (`finaliseWorkflow`, @docedit/authority) decides from the seal and store results.
 *    Only a store of the sealed bytes gives `finalised`.
 * 4. Then, and only then, `recordTransition` moves the workflow to `finalised`: the lock is stored
 *    under a new grants revision when it differs, the room writes the control commit of the
 *    revision, the state moves and `workflow.transition` is audited. The event `finalised` is
 *    returned for the caller to raise (`raiseWorkflowEvents`), as the other transitions do.
 *
 * When the store fails, or stores other bytes, the workflow stays `completed`, nothing is raised,
 * and the gate's outcome has `alert: true` and the failure, for the operator.
 *
 * Not built: the retry of a run that stopped (the spec states no policy), and the signed chain head
 * (FRW-054 criterion 3), which needs the signing service.
 */
import { finaliseWorkflow, type FinalisationOutcome } from '@docedit/authority';
import type { DocRef } from '../storage/types.ts';
import type { RaisedEvent } from './progress.ts';
import type { SealedPdfStore } from './sealed-store.ts';
import { recordTransition, type ControlRecord, type TransitionDeps } from './transitions.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

export interface FinaliseSealedRequest {
  readonly ref: DocRef;
  /** The surrogate of the service that finalises. */
  readonly actor: string;
  /** The sealed bytes and the hash the signing service gave for them. */
  readonly bytes: Uint8Array;
  readonly sealedHash: string;
  /** Whether the seal carries an RFC 3161 time-stamp token (FRW-053). A seal without one is refused. */
  readonly timestamped: boolean;
  /** Unix ms of the end of the retention of the stored bytes. */
  readonly retainUntilMs: number;
}

export type FinaliseSealedOutcome =
  | {
      readonly ok: true;
      readonly gate: FinalisationOutcome;
      /** The workflow after the run: `finalised`, or the unchanged `completed` when the gate stopped. */
      readonly resource: WorkflowResourceView;
      readonly control: ControlRecord | null;
      /** `finalised` when the workflow moved; empty when the gate stopped it. */
      readonly raised: readonly RaisedEvent[];
    }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: 'not_found' }
        | { readonly code: 'invalid_state'; readonly state: string }
        | { readonly code: 'conflict'; readonly state: string; readonly rev: number };
    };

export async function finaliseSealed(
  deps: TransitionDeps & { readonly sealed: SealedPdfStore },
  req: FinaliseSealedRequest,
): Promise<FinaliseSealedOutcome> {
  const { ref } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  if (current.state !== 'completed')
    return { ok: false, problem: { code: 'invalid_state', state: current.state } };

  // A seal without a time-stamp is not stored: the gate would refuse it, and bytes that are stored
  // cannot be removed (FRW-053 criterion 5).
  if (!req.timestamped) {
    const gate = finaliseWorkflow({
      compile: { ok: true },
      seal: { ok: true, timestamped: false, sealedHash: req.sealedHash },
    });
    return { ok: true, gate, resource: current, control: null, raised: [] };
  }

  const stored = await deps.sealed.store({
    tenant: ref.tenant,
    docId: ref.doc,
    workflowId: current.id,
    bytes: req.bytes,
    sealedHash: req.sealedHash,
    retainUntilMs: req.retainUntilMs,
  });
  const gate = finaliseWorkflow({
    compile: { ok: true },
    seal: { ok: true, timestamped: true, sealedHash: req.sealedHash },
    store: stored.store,
  });
  if (gate.status !== 'finalised')
    return { ok: true, gate, resource: current, control: null, raised: [] };

  const moved = await recordTransition(deps, {
    ref,
    actor: req.actor,
    from: current,
    write: { to: 'finalised' },
    note: { sealedHash: req.sealedHash },
    anchor: true,
  });
  if (!moved.ok) return { ok: false, problem: moved.problem };
  return {
    ok: true,
    gate,
    resource: moved.resource,
    control: moved.control,
    raised: [{ name: 'finalised' }],
  };
}
