/**
 * Why an asset failed (BE-043; SEC-038; SEC-040). The reasons are this worker's own vocabulary; the
 * registry code of 05 §5.8 that a job or `asset.failed` carries is derived from them
 * (`registryCode`). Messages name rules and numbers only, never content (BE-088).
 */

export const FAILURE_REASONS = [
  /** The declared type differs from the detected type (10 §3.5, content-type confusion). */
  'type_mismatch',
  /** The detected type is not one the worker accepts. */
  'unsupported_type',
  /** The type is accepted, but the file uses a construct the worker cannot convert. */
  'unsupported_content',
  /** The file is larger than the byte limit of its type. */
  'too_large',
  /** The declared dimensions or the decoded size are beyond the pixel limits (pixel bombs). */
  'pixel_limit',
  /** Too many frames, or too many pixels across frames (animated bombs). */
  'frame_limit',
  /** Too many scans in a progressive JPEG (a CPU bomb). */
  'scan_limit',
  /** An archive beyond the limits on entries, sizes or ratios (decompression bombs). */
  'archive_limit',
  /** An archive inside an archive where none is allowed. */
  'nested_archive',
  /** An SVG drawing beyond its limits on elements, depth, shapes or path commands (reference bombs). */
  'drawing_limit',
  /** Truncated or structurally invalid. */
  'malformed',
  /** Scripts, external references, document type declarations, macros, encryption, unsafe names. */
  'unsafe_content',
  /** The decoder refused the file or threw. */
  'decode_failed',
  /** A re-encoded output is larger than the output limit. */
  'output_limit',
  /** The sandbox was stopped at its time or memory limit, or crashed. */
  'resource_limit',
  /** Nothing was uploaded to the quarantine key. */
  'missing_upload',
  /** The quarantined object does not have the declared size. */
  'size_mismatch',
  /** The sandbox answered with something the supervisor does not accept. */
  'bad_reply',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export function isFailureReason(value: unknown): value is FailureReason {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value);
}

/** A file the worker refuses. Thrown inside the sandbox and turned into a reply. */
export class AssetError extends Error {
  override name = 'AssetError';
  readonly reason: FailureReason;
  constructor(reason: FailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The registry code of 05 §5.8 for a reason: limits are `too_large`, the rest `validation_failed`. */
export function registryCode(reason: FailureReason): 'too_large' | 'validation_failed' {
  switch (reason) {
    case 'too_large':
    case 'pixel_limit':
    case 'frame_limit':
    case 'scan_limit':
    case 'archive_limit':
    case 'drawing_limit':
    case 'output_limit':
    case 'resource_limit':
      return 'too_large';
    default:
      return 'validation_failed';
  }
}
