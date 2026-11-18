/**
 * Seal the final PDF with the signing service, then finalise (12 §8.2 steps 3 and 4; FRW-052
 * criterion 5, FRW-053).
 *
 * 1. The workflow must be `completed`. Any other state is refused and nothing is sent.
 * 2. The PDF is sent to the signing service with the document, `seq` and the hashes of the two
 *    compiles (`SigningClient`). `finalisation.seal` of the workflow names the level.
 * 3. A failure that can pass (the service or the time-stamp authority not answering, a rate limit)
 *    is retried after the delays the caller sets. There is no default: the specification states
 *    no retry policy (Open questions 26).
 * 4. When the attempts are used up, the workflow stays `completed`, nothing is stored, `finalised`
 *    is not raised, a `workflow.finalisation_failed` audit entry is written and the operator is
 *    alerted through the `alert` port. The run can be started again later.
 * 5. A seal with a time-stamp token goes to `finaliseSealed`, which stores it write-once and moves
 *    the workflow to `finalised`. The time of the seal is the token's, returned as `timestampTime`.
 *    Every other time (the transition, the audit, the control commit) is `deps.now()`, the
 *    server's clock.
 *
 * Not built: scheduling of a later run (a job of the queue, as the renewal has), and a channel that
 * delivers the alert. `alert` is a port; the default composition has none (no channel is specified).
 */
import { finaliseWorkflow, type FinalisationOutcome } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import type { DocRef } from '../storage/types.ts';
import { finaliseSealed, type FinaliseSealedOutcome } from './finalise-sealed.ts';
import type { SealedPdfStore } from './sealed-store.ts';
import type { TransitionDeps } from './transitions.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';
import type { SigningClient, SigningFailure } from './signing-client.ts';

/** What the operator is told when finalisation stops at the seal. */
export interface OperatorAlert {
  readonly kind: 'workflow.finalisation_stopped';
  readonly tenant: string;
  readonly doc: string;
  readonly workflow: string;
  readonly stage: 'seal';
  readonly reason: SigningFailure;
  /** The signing service's code, for the operator. */
  readonly code: string;
  readonly attempts: number;
  /** Whether a later run can succeed without a change by a person. */
  readonly retryable: boolean;
}

export interface SealAndFinaliseDeps extends TransitionDeps {
  readonly sealed: SealedPdfStore;
  readonly signing: SigningClient;
  readonly alert: (alert: OperatorAlert) => void | Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  /** At least 1 attempt; the wait before attempt n + 1 is `delaysMs[n - 1]`, the last one repeating. */
  readonly retry: { readonly attempts: number; readonly delaysMs: readonly number[] };
}

export interface SealAndFinaliseRequest {
  readonly ref: DocRef;
  readonly actor: string;
  /** The final PDF, as accepted from an equal pair of compiles (EXP-079). */
  readonly pdf: Uint8Array;
  readonly compileSha256: readonly [string, string];
  /** The `seq` the PDF was compiled at (the workflow's `completedSeq`). */
  readonly seq: number;
  readonly retainUntilMs: number;
}

export type SealAndFinaliseOutcome =
  | {
      readonly ok: true;
      readonly sealed: true;
      readonly attempts: number;
      /** The time in the seal's time-stamp token: the third party's time. */
      readonly timestampTime: Date;
      readonly final: Extract<FinaliseSealedOutcome, { readonly ok: true }>;
    }
  | {
      readonly ok: true;
      readonly sealed: false;
      readonly attempts: number;
      readonly gate: FinalisationOutcome;
      /** The workflow, unchanged: still `completed`. */
      readonly resource: WorkflowResourceView;
      readonly retryable: boolean;
    }
  | {
      readonly ok: false;
      readonly problem: Extract<FinaliseSealedOutcome, { ok: false }>['problem'];
    };

export async function sealAndFinalise(
  deps: SealAndFinaliseDeps,
  req: SealAndFinaliseRequest,
): Promise<SealAndFinaliseOutcome> {
  const { ref } = req;
  const attemptsAllowed = deps.retry.attempts;
  if (!Number.isInteger(attemptsAllowed) || attemptsAllowed < 1)
    throw new RangeError('sealAndFinalise: retry.attempts must be an integer of at least 1');

  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  if (current.state !== 'completed')
    return { ok: false, problem: { code: 'invalid_state', state: current.state } };

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const out = await deps.signing.seal({
      tenant: ref.tenant,
      documentId: ref.doc,
      seq: req.seq,
      pdf: req.pdf,
      compileSha256: [req.compileSha256[0], req.compileSha256[1]],
      seal: current.members.finalisation?.seal,
    });
    if (out.ok) {
      const final = await finaliseSealed(deps, {
        ref,
        actor: req.actor,
        bytes: out.pdf,
        sealedHash: out.sealedHash,
        timestamped: out.timestamped,
        retainUntilMs: req.retainUntilMs,
      });
      if (!final.ok) return { ok: false, problem: final.problem };
      return { ok: true, sealed: true, attempts, timestampTime: out.timestampTime, final };
    }
    if (out.retryable && attempts < attemptsAllowed) {
      const delays = deps.retry.delaysMs;
      const wait = delays[Math.min(attempts - 1, delays.length - 1)] ?? 0;
      await deps.sleep(wait);
      continue;
    }
    // The run stops here. The workflow is not touched: it stays `completed`.
    const gate = finaliseWorkflow({
      compile: { ok: true },
      seal: { ok: false, reason: out.reason },
    });
    await deps.audit?.record([
      {
        id: uuid7(),
        tenant: ref.tenant,
        doc: ref.doc,
        actor: 'system',
        kind: 'workflow.finalisation_failed',
        data: {
          workflow: current.id,
          stage: 'seal',
          reason: out.reason,
          code: out.code,
          attempts,
        },
        at: deps.now(),
      },
    ]);
    await deps.alert({
      kind: 'workflow.finalisation_stopped',
      tenant: ref.tenant,
      doc: ref.doc,
      workflow: current.id,
      stage: 'seal',
      reason: out.reason,
      code: out.code,
      attempts,
      retryable: out.retryable,
    });
    return { ok: true, sealed: false, attempts, gate, resource: current, retryable: out.retryable };
  }
}
