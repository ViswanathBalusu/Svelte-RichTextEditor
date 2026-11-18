/**
 * The proof that the control plane queued an export job (EXP-067 criterion 4; proposed in
 * docs/adr/0376-w2-EXP-067-queue-proof.md).
 *
 * The control plane writes a keyed hash (HMAC-SHA-256) of the job's tenant, kind, document, cache
 * key and payload into the payload member `queueProof`. A worker that holds the same key checks it
 * before it reads the payload and refuses a job without a valid proof. A row written to the queue by
 * anything else (a copied row, a hand-made payload, a changed option) fails the check. The key is
 * a deployment setting, `DOCEDIT_EXPORT_PROOF_KEY`; without it no proof is written or checked.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The payload member that holds the proof. */
export const QUEUE_PROOF_MEMBER = 'queueProof';

/** The parts of a job that the proof covers besides its payload. */
export interface ProofSubject {
  tenant: string;
  kind: string;
  doc: string | null;
  cacheKey: string | null;
}

/** JSON with the members of every object in code-point order, so equal values give equal text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function proofOf(
  key: string | Uint8Array,
  subject: ProofSubject,
  payload: Readonly<Record<string, unknown>>,
): string {
  const { [QUEUE_PROOF_MEMBER]: _own, ...rest } = payload;
  const text = canonical([subject.tenant, subject.kind, subject.doc, subject.cacheKey, rest]);
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** The payload with its proof. */
export function withQueueProof(
  key: string | Uint8Array,
  subject: ProofSubject,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...payload, [QUEUE_PROOF_MEMBER]: proofOf(key, subject, payload) };
}

/** True when the payload carries the proof this key gives for the job. */
export function checkQueueProof(
  key: string | Uint8Array,
  subject: ProofSubject,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const given = payload[QUEUE_PROOF_MEMBER];
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  const want = Buffer.from(proofOf(key, subject, payload), 'hex');
  return timingSafeEqual(want, Buffer.from(given, 'hex'));
}
