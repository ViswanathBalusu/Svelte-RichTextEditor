/**
 * The finalisation gate of a workflow (12 §6.2, §8.2; FRW-049, FRW-053, FRW-054), as a pure function.
 *
 * A workflow reaches `completed` when its last participant completes. Finalisation then runs three
 * steps in order: compile the final PDF at `completedSeq`, seal it with a PAdES signature and an
 * RFC 3161 time-stamp, and store the sealed bytes in write-once storage. This module decides the
 * state after each attempt and the events to raise. The steps themselves are the export's, the
 * signing service's and the store's; their results are passed in.
 *
 * - `completed` is always raised: finalisation starts from a completed workflow.
 * - A failed compile stops the run. The workflow stays `completed`, `finalised` is not raised, and
 *   the diagnostics are returned for the owner and the operator (FRW-049 criterion 3).
 * - A seal without a time-stamp is refused (FRW-053 criterion 5): the workflow stays `completed`.
 * - A store that fails, or that stores bytes other than the sealed bytes, leaves the workflow at
 *   `completed` (FRW-054 criterion 2). Only a store of the sealed bytes raises `finalised`.
 * - `alert` is true whenever the run stops, so the operator can be told. Delivering the alert is the
 *   workflow service's.
 *
 * Not built here: the control commit that FRW-054 writes on `finalised`, the write-once store, the
 * signed chain head, and the retry policy (the spec does not state one; Open questions 26).
 */

export type FinalisationStage = 'compile' | 'seal' | 'store';

export type CompileResult =
  { readonly ok: true } | { readonly ok: false; readonly diagnostics: readonly string[] };

export type SealResult =
  | {
      readonly ok: true;
      /** Whether the seal carries an RFC 3161 time-stamp token. */
      readonly timestamped: boolean;
      /** Lower-case hexadecimal SHA-256 of the sealed bytes. */
      readonly sealedHash: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'tsa_unreachable' | 'signing_unavailable' | 'seal_failed';
    };

export type StoreResult =
  | { readonly ok: true; readonly storedHash: string }
  | { readonly ok: false; readonly reason: 'store_failed' };

export interface FinalisationInput {
  readonly compile: CompileResult;
  /** Required once the compile has succeeded; ignored after a failed compile. */
  readonly seal?: SealResult;
  /** Required once the seal has succeeded; ignored otherwise. */
  readonly store?: StoreResult;
}

export type FailureCode =
  | 'compile_failed'
  | 'tsa_unreachable'
  | 'signing_unavailable'
  | 'seal_failed'
  | 'no_timestamp'
  | 'store_failed'
  | 'stored_hash_differs'
  | 'seal_missing'
  | 'store_missing';

export interface FinalisationFailure {
  readonly stage: FinalisationStage;
  readonly code: FailureCode;
  /** The compile diagnostics, for a compile failure; empty otherwise. */
  readonly diagnostics: readonly string[];
}

export interface FinalisationOutcome {
  /** `completed` unless the sealed bytes are stored (then `finalised`). */
  readonly status: 'completed' | 'finalised';
  /** The events to raise, in order. `completed` is always first. */
  readonly raised: readonly ('completed' | 'finalised')[];
  /** Where the run stopped, or null when the workflow is `finalised`. */
  readonly stoppedAt: FinalisationStage | null;
  readonly failure: FinalisationFailure | null;
  /** True when the run stopped and the operator must be told. */
  readonly alert: boolean;
  /** The hash of the sealed bytes, once a seal has succeeded. */
  readonly sealedHash: string | null;
}

function stopped(
  stage: FinalisationStage,
  code: FailureCode,
  diagnostics: readonly string[],
  sealedHash: string | null,
): FinalisationOutcome {
  return {
    status: 'completed',
    raised: ['completed'],
    stoppedAt: stage,
    failure: { stage, code, diagnostics },
    alert: true,
    sealedHash,
  };
}

function sealFailureCode(
  reason: 'tsa_unreachable' | 'signing_unavailable' | 'seal_failed',
): FailureCode {
  return reason;
}

/** The state of a completed workflow after one finalisation run. */
export function finaliseWorkflow(input: FinalisationInput): FinalisationOutcome {
  if (!input.compile.ok)
    return stopped('compile', 'compile_failed', input.compile.diagnostics, null);
  const seal = input.seal;
  if (seal === undefined) return stopped('seal', 'seal_missing', [], null);
  if (!seal.ok) return stopped('seal', sealFailureCode(seal.reason), [], null);
  if (!seal.timestamped) return stopped('seal', 'no_timestamp', [], null);
  const store = input.store;
  if (store === undefined) return stopped('store', 'store_missing', [], seal.sealedHash);
  if (!store.ok) return stopped('store', 'store_failed', [], seal.sealedHash);
  if (store.storedHash !== seal.sealedHash)
    return stopped('store', 'stored_hash_differs', [], seal.sealedHash);
  return {
    status: 'finalised',
    raised: ['completed', 'finalised'],
    stoppedAt: null,
    failure: null,
    alert: false,
    sealedHash: seal.sealedHash,
  };
}
