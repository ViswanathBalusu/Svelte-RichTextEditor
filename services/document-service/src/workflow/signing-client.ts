/**
 * The document service's client of the signing service (12 §8.2 step 3; FRW-052, FRW-053).
 *
 * Only the document service holds a credential for the signing service; no export or LaTeX worker
 * does. The client sends the PDF with the document, `seq` and hash it is bound to, and the hashes of
 * the two compiles that EXP-079 compared. It checks what comes back before anyone stores it: the
 * hash must be the hash of the bytes, the bytes must begin with the PDF that was sent (a seal only
 * appends), and the answer must say the seal carries a time-stamp token.
 *
 * The wire is described in services/signing-service/src/http.ts. The two services share no code.
 */
import { createHash } from 'node:crypto';

export interface SigningJob {
  readonly tenant: string;
  readonly documentId: string;
  readonly seq: number;
  readonly pdf: Uint8Array;
  /** The SHA-256 of each of the two compiles, lower-case hexadecimal. */
  readonly compileSha256: readonly [string, string];
  /** The workflow's `finalisation.seal` (`pades-b-lt` or `pades-b-lta`); absent means B-LT. */
  readonly seal?: string | undefined;
}

/** Why a seal was not made, in the words of `finaliseWorkflow` (@docedit/authority). */
export type SigningFailure = 'tsa_unreachable' | 'signing_unavailable' | 'seal_failed';

export type SigningAttempt =
  | {
      readonly ok: true;
      readonly pdf: Uint8Array;
      /** SHA-256 of `pdf`, computed here, not taken on trust. */
      readonly sealedHash: string;
      readonly timestamped: true;
      /** The time of the seal's time-stamp token (`genTime`), from the authority's clock. */
      readonly timestampTime: Date;
      readonly profile: 'B-LT' | 'B-LTA';
    }
  | {
      readonly ok: false;
      readonly reason: SigningFailure;
      /** The service's code, or `unreachable` when no answer came. */
      readonly code: string;
      /** Whether asking again later can succeed. */
      readonly retryable: boolean;
    };

export interface SigningClient {
  seal(job: SigningJob): Promise<SigningAttempt>;
}

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface HttpSigningClientOptions {
  /** The service's base URL, without a trailing slash. */
  readonly url: string;
  /** The document service's credential (the bearer secret). */
  readonly credential: string;
  /** How long to wait for one answer, ms. There is no default: the spec gives none. */
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

interface Wire {
  ok?: unknown;
  code?: unknown;
  retryable?: unknown;
  pdf?: unknown;
  sealedSha256?: unknown;
  profile?: unknown;
  timestamped?: unknown;
  timestampTime?: unknown;
}

export class HttpSigningClient implements SigningClient {
  readonly #o: HttpSigningClientOptions;
  constructor(options: HttpSigningClientOptions) {
    this.#o = options;
  }

  async seal(job: SigningJob): Promise<SigningAttempt> {
    const unavailable = (code: string): SigningAttempt => ({
      ok: false,
      reason: 'signing_unavailable',
      code,
      retryable: true,
    });
    const failed = (code: string): SigningAttempt => ({
      ok: false,
      reason: 'seal_failed',
      code,
      retryable: false,
    });
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.url}/v1/seal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#o.credential}`,
        },
        body: JSON.stringify({
          tenant: job.tenant,
          documentId: job.documentId,
          seq: job.seq,
          pdfSha256: sha256Hex(job.pdf),
          compileSha256: job.compileSha256,
          ...(job.seal !== undefined ? { seal: job.seal } : {}),
          pdf: Buffer.from(job.pdf).toString('base64'),
        }),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      return unavailable('unreachable');
    }
    let wire: Wire;
    try {
      wire = (await res.json()) as Wire;
    } catch {
      return res.status >= 500 ? unavailable('bad_answer') : failed('bad_answer');
    }
    if (!res.ok || wire.ok !== true) {
      const code = typeof wire.code === 'string' ? wire.code : `http_${res.status}`;
      if (code === 'tsa_unreachable')
        return { ok: false, reason: 'tsa_unreachable', code, retryable: true };
      if (wire.retryable === true) return unavailable(code);
      return failed(code);
    }
    // The answer is checked before it is believed.
    if (
      typeof wire.pdf !== 'string' ||
      typeof wire.sealedSha256 !== 'string' ||
      wire.timestamped !== true ||
      typeof wire.timestampTime !== 'string' ||
      (wire.profile !== 'B-LT' && wire.profile !== 'B-LTA')
    )
      return failed('bad_answer');
    const sealed = new Uint8Array(Buffer.from(wire.pdf, 'base64'));
    const sealedHash = sha256Hex(sealed);
    const when = new Date(wire.timestampTime);
    if (sealedHash !== wire.sealedSha256) return failed('hash_differs');
    if (Number.isNaN(when.getTime())) return failed('bad_answer');
    if (
      sealed.length <= job.pdf.length ||
      Buffer.compare(Buffer.from(sealed.subarray(0, job.pdf.length)), Buffer.from(job.pdf)) !== 0
    )
      return failed('not_an_append');
    return {
      ok: true,
      pdf: sealed,
      sealedHash,
      timestamped: true,
      timestampTime: when,
      profile: wire.profile,
    };
  }
}
