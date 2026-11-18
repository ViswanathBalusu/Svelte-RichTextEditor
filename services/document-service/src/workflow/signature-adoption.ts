/**
 * Adopting a signature on the service side (12 §8.1 step 2, §3.3, §11; 05 §6.2; FRW-045;
 * docs/adr/0396-w4-FRW-045-signature-adoption.md, proposed).
 *
 * A participant adopts a signature or initials by typing, drawing or uploading. The client turns
 * each into an image and uploads it like any other asset (PRO-061), so the three modes take one path
 * through the asset worker: quarantine, validation, re-encoding, hashing, storage. `mode` only
 * records how the image was made. `adoptSignature` is the check a use of that asset makes:
 *
 * - `mode` is `typed`, `drawn` or `uploaded`, and the asset identifier is a UUID;
 * - the asset belongs to this document and was uploaded by the caller (a participant signs with their
 *   own image, never another person's);
 * - the asset is `ready`. One still `quarantined` or `processing` cannot be used yet, and one that
 *   `failed` is refused with the worker's reason;
 * - the stored object is an image, and its bytes hash to the hash the worker recorded.
 *
 * It answers the value the field will hold, `{ asset, mode }` (validated by `fields/values.ts` of the
 * model), and the SHA-256 of the stored image, which the service computes from the stored bytes
 * (`signatureImageHash`): no hash from the client reaches the evidence (FRW-040 criterion 3).
 */
import { signatureImageHash } from '@docedit/authority';
import type { AssetRegistry } from '../control-plane/assets.ts';
import type { AssetStore } from '../storage/types.ts';

export const SIGNATURE_MODES = ['typed', 'drawn', 'uploaded'] as const;
export type SignatureMode = (typeof SIGNATURE_MODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdoptionDeps {
  readonly assets: Pick<AssetRegistry, 'get'>;
  readonly finals: Pick<AssetStore, 'getFinal'>;
}

export type AdoptionProblem =
  | { readonly code: 'validation_failed'; readonly path: string; readonly rule: string }
  | { readonly code: 'not_found' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'not_ready'; readonly state: string }
  | { readonly code: 'failed'; readonly reason: string }
  | { readonly code: 'not_an_image' }
  | { readonly code: 'corrupt' };

export interface Adoption {
  /** The value the signature or initials field will hold. */
  readonly value: { readonly asset: string; readonly mode: SignatureMode };
  /** SHA-256 of the stored image, lower-case hex, computed from the stored bytes. */
  readonly imageHash: string;
}

export async function adoptSignature(
  deps: AdoptionDeps,
  req: {
    tenant: string;
    doc: string;
    /** The caller's surrogate: the uploader of the asset must be this person. */
    actor: string;
    asset: unknown;
    mode: unknown;
  },
): Promise<{ ok: true; adoption: Adoption } | { ok: false; problem: AdoptionProblem }> {
  const { asset, mode } = req;
  if (typeof mode !== 'string' || !(SIGNATURE_MODES as readonly string[]).includes(mode))
    return {
      ok: false,
      problem: { code: 'validation_failed', path: '/mode', rule: 'typed, drawn or uploaded' },
    };
  if (typeof asset !== 'string' || !UUID.test(asset))
    return {
      ok: false,
      problem: { code: 'validation_failed', path: '/asset', rule: 'the identifier of an asset' },
    };
  const row = await deps.assets.get(req.tenant, asset);
  // An asset of another document is as good as none: its existence is not told.
  if (row === null || row.doc !== req.doc) return { ok: false, problem: { code: 'not_found' } };
  if (row.createdBy !== req.actor) return { ok: false, problem: { code: 'forbidden' } };
  if (row.state === 'failed')
    return { ok: false, problem: { code: 'failed', reason: row.failure?.reason ?? 'it failed' } };
  if (row.state !== 'ready') return { ok: false, problem: { code: 'not_ready', state: row.state } };
  if (row.contentType === null || !row.contentType.startsWith('image/'))
    return { ok: false, problem: { code: 'not_an_image' } };
  const bytes = row.sha256 === null ? null : await deps.finals.getFinal(req.tenant, row.sha256);
  if (bytes === null || bytes.length === 0) return { ok: false, problem: { code: 'corrupt' } };
  const imageHash = await signatureImageHash(bytes);
  if (row.sha256 !== null && row.sha256 !== imageHash)
    return { ok: false, problem: { code: 'corrupt' } };
  return {
    ok: true,
    adoption: { value: { asset: row.id, mode: mode as SignatureMode }, imageHash },
  };
}
