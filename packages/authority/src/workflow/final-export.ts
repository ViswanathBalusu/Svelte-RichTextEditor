/**
 * The request for the final PDF of a completed workflow (12 §8.2 step 1; FRW-049), as a pure function.
 *
 * - The export is pinned to `completedSeq`, the sequence number of the last completion, so it typesets
 *   the document as it stood at completion and not a later head (FRW-049 criterion 2).
 * - Field values are flattened into the text and the `final` profile is used (12 §8.2 step 1;
 *   EXP-026). Blank fields are not an option here.
 * - Certificate pages are appended only when `finalisation.certificate` is true (FRW-049 criterion 5).
 *   The spec gives no default for an absent option; this module reads absent as false (ADR 0250,
 *   item 2). The spec example sets it to true.
 * - Only a `completed` workflow yields a request. A `finalised` workflow has already been sealed, and
 *   a workflow in any other state has not completed.
 *
 * The export job, the typesetting and the certificate pages are the export's (EXP) and the job
 * creation is the workflow service's; this module only says what the job must be asked for.
 */

/** The workflow states this module reads. */
export type WorkflowStatus =
  | 'draft'
  | 'sent'
  | 'in_progress'
  | 'correcting'
  | 'completed'
  | 'finalised'
  | 'voided'
  | 'declined'
  | 'expired';

/** The `finalisation` object of the workflow definition (12 §6.1). */
export interface FinalisationOptions {
  readonly seal?: string;
  readonly certificate?: boolean;
}

/** What the export job must be asked for. */
export interface FinalExportRequest {
  /** The export is pinned to this sequence number. */
  readonly seq: number;
  /** Field values are printed into the text. */
  readonly fields: 'flatten';
  readonly profile: 'final';
  /** Whether certificate pages are appended after the body. */
  readonly certificate: boolean;
}

export type FinalExportVerdict =
  | { readonly ok: true; readonly request: FinalExportRequest }
  | { readonly ok: false; readonly reason: 'not_completed' | 'bad_completed_seq' };

/** The request for the final PDF of a workflow in `status`, completed at `completedSeq`. */
export function finalExportRequest(
  status: WorkflowStatus,
  completedSeq: number,
  finalisation: FinalisationOptions | undefined,
): FinalExportVerdict {
  if (status !== 'completed') return { ok: false, reason: 'not_completed' };
  if (!Number.isSafeInteger(completedSeq) || completedSeq < 0)
    return { ok: false, reason: 'bad_completed_seq' };
  return {
    ok: true,
    request: {
      seq: completedSeq,
      fields: 'flatten',
      profile: 'final',
      certificate: finalisation?.certificate === true,
    },
  };
}
