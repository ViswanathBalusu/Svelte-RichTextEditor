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
import { PortError, type AssetsPort, type FieldsPort, type WorkflowPort } from '@docedit/protocol';
import type {
  AdoptOutcome,
  ConsentAcceptOutcome,
  ConsentDeclineOutcome,
  ConsentLoadOutcome,
  ConsentService,
  SignatureAdoption,
  SignatureKind,
  SignProgress,
  SigningService,
  SignOutcome,
} from '@docedit/ui';

/** What the service needs of the session: the ports and the document they are for. */
export interface SigningSource {
  readonly assets: Pick<AssetsPort, 'upload'>;
  readonly fields: Pick<FieldsPort, 'sign'>;
  readonly docId: string;
  /** The workflow port for the consent step (FRW-044); absent: the step is not shown. */
  readonly workflow?: Pick<WorkflowPort, 'consent' | 'participant'>;
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

/**
 * The consent step over the workflow port (FRW-044; FRW-033): the text and the acceptance on record are
 * read, the acceptance is recorded by the service (it holds the text and takes the hash and the time;
 * the body is empty), and a decline goes to the participant's own decline endpoint with its reason.
 * participant is the identifier the server reported for this participant (wf.changed); without it,
 * or without the port, nothing here calls the server.
 */
export function consentService(
  source: () => SigningSource | null,
  participant: () => string | null,
): ConsentService {
  const ready = () => {
    const current = source();
    const id = participant();
    return current?.workflow && id !== null ? { current, port: current.workflow, id } : null;
  };
  return {
    async load(): Promise<ConsentLoadOutcome> {
      // A backend with no workflow port has no consent to accept; the service still refuses a signing
      // that needs one.
      if (!source()?.workflow) return { ok: false, reason: 'none' };
      const got = ready();
      if (!got) return { ok: false, reason: 'failed' };
      try {
        const view = await got.port.consent(got.current.docId, got.id);
        return {
          ok: true,
          consent: {
            textId: view.textId,
            version: view.version,
            text: view.text,
            acceptedAt: view.acceptedAt,
          },
        };
      } catch (error) {
        // The workflow names no consent text, or this kind of participant accepts none (conflict).
        return {
          ok: false,
          reason: error instanceof PortError && error.code === 'conflict' ? 'none' : 'failed',
        };
      }
    },
    async accept(): Promise<ConsentAcceptOutcome> {
      const got = ready();
      if (!got) return { ok: false, reason: 'failed' };
      try {
        await got.port.participant(got.current.docId, got.id, 'consent');
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof PortError && error.code === 'forbidden' ? 'forbidden' : 'failed',
        };
      }
    },
    async decline(reason): Promise<ConsentDeclineOutcome> {
      const got = ready();
      const trimmed = reason.trim();
      if (trimmed === '') return { ok: false, reason: 'reason_required' };
      if (!got) return { ok: false, reason: 'failed' };
      try {
        await got.port.participant(got.current.docId, got.id, 'decline', { reason: trimmed });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    },
  };
}

/** What the progress of the signing reads from the core: the fields and the roles of the participant. */
export interface SignProgressSource {
  fillFields(): readonly {
    readonly id: string;
    readonly kind?: string;
    readonly assignee: string | null;
    readonly filled: boolean;
  }[];
  readonly permissions: {
    get(): { readonly fill: { readonly roles: readonly string[] } | null } | null;
  };
}

/**
 * The participant's own signature and initials fields: how many are signed, of how many (FRW-048).
 * signedField counts as signed even before its value has arrived through the channel. Null when
 * the participant has no such field.
 */
export function signProgress(core: SignProgressSource, signedField?: string): SignProgress | null {
  const roles = new Set(core.permissions.get()?.fill?.roles ?? []);
  const own = core
    .fillFields()
    .filter(
      (f) =>
        (f.kind === 'signature' || f.kind === 'initials') &&
        f.assignee !== null &&
        roles.has(f.assignee),
    );
  if (own.length === 0) return null;
  return {
    signed: own.filter((f) => f.filled || f.id === signedField).length,
    total: own.length,
  };
}

export function signingService(
  core: EditorCore,
  source: () => SigningSource | null,
  participant: () => string | null = () => null,
): SigningService {
  const kept: Record<SignatureKind, SignatureAdoption | null> = {
    signature: null,
    initials: null,
  };
  return {
    consent: consentService(source, participant),
    request: core.signRequest,
    progress: (signedField) => signProgress(core as unknown as SignProgressSource, signedField),
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
