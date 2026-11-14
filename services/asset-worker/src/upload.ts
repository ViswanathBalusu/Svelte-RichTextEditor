/**
 * The worker's side of uploading into quarantine (BE-042; 05 §6.2 `POST /documents/{id}/assets`).
 * The control plane checks the caller's capability and creates the `assets` row; it then uses
 * these two functions: `checkDeclaredUpload` answers `too_large` or `validation_failed` before
 * anything is created, and `presignQuarantineUpload` gives the size-bound upload into
 * `tenants/{tenant}/quarantine/{asset}`. A hash the client declares has no parameter here.
 */
import { assetKeys } from './keys.ts';
import type { PresignedUpload, S3AssetObjects } from './s3.ts';
import { registryCode, type FailureReason } from './sandbox/errors.ts';
import { contentLimits, type ContentLimits } from './sandbox/limits.ts';
import { byteLimit, checkDeclared } from './sandbox/process.ts';
import { normaliseMime, type AcceptedType } from './sandbox/types.ts';

export type DeclaredUploadCheck =
  | { ok: true; mime: AcceptedType; maxBytes: number }
  | { ok: false; code: 'too_large' | 'validation_failed'; reason: FailureReason; message: string };

/** Checks `{ filename, mime, size }` of a new upload against the accepted types and byte limits. */
export function checkDeclaredUpload(
  req: { filename?: unknown; mime?: unknown; size?: unknown },
  limits: ContentLimits = contentLimits(),
): DeclaredUploadCheck {
  if (typeof req.mime !== 'string' || req.mime.length === 0 || req.mime.length > 255)
    return {
      ok: false,
      code: 'validation_failed',
      reason: 'unsupported_type',
      message: 'mime must be a MIME type',
    };
  if (typeof req.size !== 'number')
    return {
      ok: false,
      code: 'validation_failed',
      reason: 'malformed',
      message: 'size must be a number of bytes',
    };
  if (
    req.filename !== undefined &&
    (typeof req.filename !== 'string' || req.filename.length > 1024)
  )
    return {
      ok: false,
      code: 'validation_failed',
      reason: 'malformed',
      message: 'filename must be a short string',
    };
  const bad = checkDeclared(req.mime, req.size, limits);
  if (bad)
    return { ok: false, code: registryCode(bad.reason), reason: bad.reason, message: bad.message };
  const mime = normaliseMime(req.mime) as AcceptedType;
  return { ok: true, mime, maxBytes: byteLimit(mime, limits) };
}

export interface QuarantineUpload extends PresignedUpload {
  /** The object key the upload goes to. */
  key: string;
}

/**
 * A pre-signed upload of exactly `size` bytes into the asset's quarantine key, valid for
 * `lifetimeSeconds` (a setting; the spec gives no lifetime). `store` should hold credentials that
 * may only write to quarantine keys.
 */
export function presignQuarantineUpload(
  store: Pick<S3AssetObjects, 'presignUpload'>,
  args: { tenant: string; asset: string; size: number; lifetimeSeconds?: number },
): QuarantineUpload {
  const key = assetKeys.quarantine(args.tenant, args.asset);
  return { ...store.presignUpload(key, args.size, args.lifetimeSeconds ?? 900), key };
}
