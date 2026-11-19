/**
 * Long-term validation and time-stamp renewal of a finalised workflow's sealed PDF (12 §8.2 step 5;
 * FRW-056 criteria 1 to 3).
 *
 * `extendFinalised` reads the newest stored bytes of the workflow's sealed PDF, has the signing
 * service append fresh validation data and a further document time-stamp, and stores the result as
 * a further object that begins with those bytes. The sealed object, and every earlier update, stay
 * as they were; `GET /documents/{id}/workflow/final` returns the latest. A repeat with the same
 * idempotency key adds nothing (the signing service returns the first result; the store takes the
 * same bytes as a no-op).
 *
 * `sealedRenewalSigner` is the signing service's side of the renewal job (`RenewalSigner`,
 * control-plane/jobs/workflow-renewal.ts): it makes one renewal and reports the new expiry.
 *
 * Not built: the scheduler that finds the workflows whose time-stamp expires soon and enqueues the
 * renewal job (`planRenewal` and the job exist; nothing composes them), and the initial expiry
 * state at finalisation.
 */
import type { RenewalResult } from '@docedit/authority';
import type { RenewalSigner } from '../control-plane/jobs/workflow-renewal.ts';
import type { SealedPdfStore } from './sealed-store.ts';
import type { SigningClient, SigningFailure } from './signing-client.ts';
import type { WorkflowResourceStore } from './workflow-resource.ts';

export interface ExtendDeps {
  readonly workflows: Pick<WorkflowResourceStore, 'read'>;
  readonly sealed: SealedPdfStore;
  readonly signing: SigningClient;
  readonly now: () => number;
  /** How long a stored update is retained, ms from now. */
  readonly retainMs: number;
}

export type ExtendFinalisedOutcome =
  | {
      readonly ok: true;
      /** The number of the update now latest: 1 for the first. */
      readonly n: number;
      readonly hash: string;
      /** The end of the newest time-stamp's validity, ms since the epoch. */
      readonly expiresAtMs: number;
      /** False when the same update was already stored. */
      readonly stored: boolean;
    }
  | { readonly ok: false; readonly reason: 'not_finalised' | 'no_sealed_pdf' }
  | {
      readonly ok: false;
      readonly reason: SigningFailure;
      readonly code: string;
      readonly retryable: boolean;
    }
  | { readonly ok: false; readonly reason: 'store_failed' | 'stale' | 'not_an_append' };

export async function extendFinalised(
  deps: ExtendDeps,
  req: {
    readonly tenant: string;
    readonly doc: string;
    /** The `seq` the workflow was sealed at (its `completedSeq`), for the service's audit. */
    readonly seq: number;
    readonly idempotencyKey: string;
    /** Add fresh validation data before the time-stamp (the long-term validation job). */
    readonly validation: boolean;
  },
): Promise<ExtendFinalisedOutcome> {
  const workflow = await deps.workflows.read(req.tenant, req.doc);
  if (workflow === null || workflow.state !== 'finalised')
    return { ok: false, reason: 'not_finalised' };
  const latest = await deps.sealed.readLatest(req.tenant, req.doc, workflow.id);
  if (latest === null) return { ok: false, reason: 'no_sealed_pdf' };
  const out = await deps.signing.extend({
    tenant: req.tenant,
    documentId: req.doc,
    seq: req.seq,
    pdf: latest.bytes,
    idempotencyKey: req.idempotencyKey,
    validation: req.validation,
  });
  if (!out.ok) return out;
  const stored = await deps.sealed.storeUpdate({
    tenant: req.tenant,
    docId: req.doc,
    workflowId: workflow.id,
    bytes: out.pdf,
    basedOnHash: latest.hash,
    retainUntilMs: deps.now() + deps.retainMs,
  });
  if (!stored.ok)
    return { ok: false, reason: stored.reason === 'not_sealed' ? 'no_sealed_pdf' : stored.reason };
  return {
    ok: true,
    n: stored.n,
    hash: stored.hash,
    expiresAtMs: out.expiresAtMs,
    stored: !stored.existing,
  };
}

/** The renewal job's signer over the sealed PDF of a finalised workflow. */
export function sealedRenewalSigner(
  deps: ExtendDeps,
  /** The `seq` the workflow was sealed at, for each document; the service's audit names it. */
  seqOf: (tenant: string, doc: string) => Promise<number>,
): RenewalSigner {
  return {
    async renew(tenant, doc, _expectedExpiresAtMs, idempotencyKey): Promise<RenewalResult> {
      const out = await extendFinalised(deps, {
        tenant,
        doc,
        seq: await seqOf(tenant, doc),
        idempotencyKey,
        validation: false,
      });
      if (out.ok) return { ok: true, newExpiresAtMs: out.expiresAtMs };
      if (out.reason === 'tsa_unreachable' || out.reason === 'signing_unavailable')
        return { ok: false, reason: out.reason };
      return { ok: false, reason: 'seal_failed' };
    },
  };
}
