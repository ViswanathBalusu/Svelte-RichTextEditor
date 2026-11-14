/**
 * The authority-side rules of the signing service (12 §8.2 step 3; §8.3; FRW-052), as pure functions.
 *
 * - `selectSealingKey` chooses the sealing key of a tenant from configuration: the operator's key, or
 *   the tenant's own key when the tenant has one (FRW-052 criterion 4). A tenant with no entry gets
 *   the operator's key. A malformed entry is refused rather than replaced by a default.
 * - `checkSealRequest` decides whether a request to seal is bound to the document, `seq` and PDF hash
 *   the caller expects, and whether it comes from the one caller allowed to seal, the document
 *   service (FRW-052 criterion 3). Only the binding and the caller are checked here.
 *
 * Not built here, and not claimed by the criteria that cite this module: the signing service itself,
 * the hardware security module or cloud key service that holds the keys (criterion 2), the trust
 * boundary and the credentials of the service (criterion 1), the authentication of the request, its
 * rate limit and its audit entry (criterion 3), the unavailable-service path (criterion 5), and the
 * choice of sealing party, which is an owner decision (SPK; 11 §10 item 11).
 */

/** The sealing key of a tenant: the operator's, or the tenant's own. */
export type SealingKey =
  | { readonly owner: 'operator'; readonly keyId: string }
  | { readonly owner: 'tenant'; readonly keyId: string };

/** The configuration: the operator's key, and any tenant that has its own. */
export interface SealingConfig {
  readonly operatorKeyId: string;
  /** Tenant identifier to the tenant's own key identifier. */
  readonly tenantKeyIds: Readonly<Record<string, string>>;
}

/**
 * The sealing key for `tenantId`. Throws a `RangeError` when the operator's key id or a tenant's
 * key id is empty, so that a misconfiguration is refused rather than sealing with a missing key.
 */
export function selectSealingKey(config: SealingConfig, tenantId: string): SealingKey {
  if (config.operatorKeyId.length === 0)
    throw new RangeError('selectSealingKey: the operator key id is empty');
  if (tenantId.length === 0) throw new RangeError('selectSealingKey: the tenant id is empty');
  // Own-property lookup only, so that a tenant id such as "__proto__" cannot reach the prototype.
  const own = Object.prototype.hasOwnProperty.call(config.tenantKeyIds, tenantId)
    ? config.tenantKeyIds[tenantId]
    : undefined;
  if (own === undefined) return { owner: 'operator', keyId: config.operatorKeyId };
  if (own.length === 0) throw new RangeError('selectSealingKey: a tenant key id is empty');
  return { owner: 'tenant', keyId: own };
}

/** A request to seal, as the signing service receives it. */
export interface SealRequest {
  readonly caller: string;
  readonly documentId: string;
  readonly seq: number;
  /** Lower-case hexadecimal SHA-256 of the PDF to seal. */
  readonly pdfSha256: string;
}

export type SealRequestVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'wrong_caller' | 'document_mismatch' | 'seq_mismatch' | 'hash_mismatch';
    };

/**
 * Whether `request` may seal the PDF the caller expects: the caller is `allowedCaller` (the document
 * service), and the document, `seq` and PDF hash equal the expected ones. The first failing check
 * names the reason.
 */
export function checkSealRequest(
  request: SealRequest,
  expected: Omit<SealRequest, 'caller'>,
  allowedCaller: string,
): SealRequestVerdict {
  if (request.caller !== allowedCaller) return { ok: false, reason: 'wrong_caller' };
  if (request.documentId !== expected.documentId) return { ok: false, reason: 'document_mismatch' };
  if (request.seq !== expected.seq) return { ok: false, reason: 'seq_mismatch' };
  if (request.pdfSha256 !== expected.pdfSha256) return { ok: false, reason: 'hash_mismatch' };
  return { ok: true };
}
