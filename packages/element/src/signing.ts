/**
 * The adoption and signing step's service over the core and the backend's ports (FRW-045,
 * FRW-046; 12 §8.1 steps 2 and 3; ui `SigningService`).
 *
 * - `request` is the core's `signRequest`: the signature or initials field the participant activated.
 * - `adopt` sends the image through the assets port, which goes through the asset worker like any
 *   upload (quarantine, validation, re-encoding, hashing, storage) and resolves once the asset is
 *   `ready`; an `asset.failed` is a refusal (`rejected`), anything else is `failed`. The adoption
 *   (`{ asset, mode }`) is kept by kind for the rest of the visit, so a signature field and an
 *   initials field are each adopted once.
 * - `sign` calls `POST /documents/{id}/fields/{fid}/sign` through the fields port with the adoption.
 *   The service writes the field in a commit of its own, so nothing here changes the document; the
 *   value arrives through the channel. A refusal is mapped to a word the step can say.
 *
 * No DOM: this runs in Node.js tests against stand-in ports.
 */
import type { EditorCore } from '@docedit/engine';
import { PortError, type AssetsPort, type FieldsPort } from '@docedit/protocol';
import type {
  AdoptOutcome,
  SignatureAdoption,
  SignatureKind,
  SigningService,
  SignOutcome,
} from '@docedit/ui';

/** What the service needs of the session: the ports and the document they are for. */
export interface SigningSource {
  readonly assets: Pick<AssetsPort, 'upload'>;
  readonly fields: Pick<FieldsPort, 'sign'>;
  readonly docId: string;
}

/** What a refused sign request says, from the server's code and words. */
export function signRefusal(error: unknown): Extract<SignOutcome, { ok: false }> {
  if (!(error instanceof PortError)) return { ok: false, reason: 'failed' };
  if (error.code === 'forbidden')
    return {
      ok: false,
      reason: /consent/i.test(error.message)
        ? 'consent'
        : /not active/i.test(error.message)
          ? 'not_active'
          : 'forbidden',
    };
  if (error.code === 'conflict' && /workflow is|not active/i.test(error.message))
    return { ok: false, reason: 'not_active' };
  return { ok: false, reason: 'failed' };
}

/**
 * What `de-sign-request` watches (FRW-071): each new request of the core to open the signing step,
 * as the identifier and key of the field. A request that is closed raises nothing, and the request
 * already open when the listener is added is not raised again. No value is read.
 */
export function signRequestWatch(core: Pick<EditorCore, 'signRequest'>): {
  subscribe(listener: (field: { fieldId: string; key: string }) => void): () => void;
} {
  return {
    subscribe(listener) {
      let seen = core.signRequest.get()?.n ?? 0;
      return core.signRequest.subscribe(() => {
        const request = core.signRequest.get();
        if (!request || request.n === seen) return;
        seen = request.n;
        listener({ fieldId: request.id, key: request.key });
      });
    },
  };
}

export function signingService(
  core: EditorCore,
  source: () => SigningSource | null,
): SigningService {
  const kept: Record<SignatureKind, SignatureAdoption | null> = {
    signature: null,
    initials: null,
  };
  return {
    request: core.signRequest,
    adopted: (kind) => kept[kind],
    async adopt(kind, mode, image, filename): Promise<AdoptOutcome> {
      const current = source();
      if (!current) return { ok: false, reason: 'failed' };
      try {
        const { asset } = await current.assets.upload(current.docId, {
          filename,
          source: image,
        });
        const adoption: SignatureAdoption = { asset, mode };
        kept[kind] = adoption;
        return { ok: true, adoption };
      } catch (error) {
        // The asset worker refused the image: `asset.failed` is a `validation_failed` (files.ts).
        return {
          ok: false,
          reason:
            error instanceof PortError && error.code === 'validation_failed'
              ? 'rejected'
              : 'failed',
        };
      }
    },
    async sign(fieldId, adoption): Promise<SignOutcome> {
      const current = source();
      if (!current) return { ok: false, reason: 'failed' };
      try {
        await current.fields.sign(current.docId, fieldId, {
          asset: adoption.asset,
          mode: adoption.mode,
        });
        return { ok: true };
      } catch (error) {
        return signRefusal(error);
      }
    },
    dismiss() {
      core.clearSignRequest();
    },
  };
}
