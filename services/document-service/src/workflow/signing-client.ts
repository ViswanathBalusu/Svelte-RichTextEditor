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
  /** Visible appearances to draw at the signature and initials fields (FRW-057). */
  readonly appearances?: AppearanceRequest | undefined;
}

/**
 * What to draw at the fields: the `fields` of `layout.json` (page and rectangle in twentieths of
 * a point from the top-left corner) and, for each signature or initials field, its lines of text.
 */
export interface AppearanceRequest {
  readonly layout: Readonly<Record<string, unknown>>;
  readonly targets: readonly {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lines: readonly string[];
  }[];
}

/** What the signing service drew and what it did not, with the reason (FRW-057 criterion 6). */
export interface AppearanceReport {
  readonly drawn: readonly string[];
  readonly diagnostics: readonly {
    readonly id: string;
    readonly key: string;
    readonly code: string;
    readonly reason: string;
  }[];
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
      /** Present when appearances were asked for. */
      readonly appearances?: AppearanceReport;
    }
  | {
      readonly ok: false;
      readonly reason: SigningFailure;
      /** The service's code, or `unreachable` when no answer came. */
      readonly code: string;
      /** Whether asking again later can succeed. */
      readonly retryable: boolean;
    };

/** A chain head to be signed and time-stamped (FRW-054 criterion 3). */
export interface AnchorJob {
  readonly tenant: string;
  readonly documentId: string;
  readonly workflow: string;
  /** The workflow's `completedSeq`. */
  readonly seq: number;
  /** Lower-case hexadecimal SHA-256 chain head at `seq`. */
  readonly chainHead: string;
}

export type AnchorAttempt =
  | {
      readonly ok: true;
      /** The signed record, canonical text. */
      readonly record: string;
      /** SHA-256 of `record`, computed here, not taken on trust. */
      readonly recordSha256: string;
      /** A detached CAdES-B-T over `recordSha256` (DER). */
      readonly cms: Uint8Array;
      readonly timestampTime: Date;
      readonly keyId: string;
    }
  | {
      readonly ok: false;
      readonly reason: SigningFailure;
      readonly code: string;
      readonly retryable: boolean;
    };

/** A sealed PDF to extend for long-term validation and renew (FRW-056). */
export interface ExtendJob {
  readonly tenant: string;
  readonly documentId: string;
  readonly seq: number;
  /** The newest stored bytes. */
  readonly pdf: Uint8Array;
  /** One request, one result: a repeat with the same key returns the first result. */
  readonly idempotencyKey: string;
  /** Add fresh validation data before the time-stamp. */
  readonly validation: boolean;
}

export type ExtendAttempt =
  | {
      readonly ok: true;
      /** The input, then the update. */
      readonly pdf: Uint8Array;
      /** SHA-256 of `pdf`, computed here. */
      readonly sealedHash: string;
      readonly timestampTime: Date;
      /** The end of the new time-stamp's validity, ms since the epoch. */
      readonly expiresAtMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: SigningFailure;
      readonly code: string;
      readonly retryable: boolean;
    };

export interface SigningClient {
  seal(job: SigningJob): Promise<SigningAttempt>;
  anchor(job: AnchorJob): Promise<AnchorAttempt>;
  extend(job: ExtendJob): Promise<ExtendAttempt>;
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
  appearances?: unknown;
}

/** The appearance report of an answer, or null when it has none or is not of the shape. */
function reportOf(v: unknown): AppearanceReport | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { drawn?: unknown; diagnostics?: unknown };
  if (!Array.isArray(o.drawn) || !o.drawn.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(o.diagnostics)) return null;
  const diagnostics: AppearanceReport['diagnostics'][number][] = [];
  for (const d of o.diagnostics as Array<Record<string, unknown>>) {
    if (typeof d['id'] !== 'string' || typeof d['code'] !== 'string') return null;
    diagnostics.push({
      id: d['id'],
      key: typeof d['key'] === 'string' ? d['key'] : '',
      code: d['code'],
      reason: typeof d['reason'] === 'string' ? d['reason'] : '',
    });
  }
  return { drawn: o.drawn as string[], diagnostics };
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
          ...(job.appearances !== undefined ? { appearances: job.appearances } : {}),
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
      ...(reportOf(wire.appearances) ? { appearances: reportOf(wire.appearances)! } : {}),
    };
  }

  async anchor(job: AnchorJob): Promise<AnchorAttempt> {
    const unavailable = (code: string): AnchorAttempt => ({
      ok: false,
      reason: 'signing_unavailable',
      code,
      retryable: true,
    });
    const failed = (code: string): AnchorAttempt => ({
      ok: false,
      reason: 'seal_failed',
      code,
      retryable: false,
    });
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.url}/v1/anchor`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#o.credential}`,
        },
        body: JSON.stringify({
          tenant: job.tenant,
          documentId: job.documentId,
          workflow: job.workflow,
          seq: job.seq,
          chainHead: job.chainHead,
        }),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      return unavailable('unreachable');
    }
    let wire: AnchorWire;
    try {
      wire = (await res.json()) as AnchorWire;
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
    if (
      typeof wire.record !== 'string' ||
      typeof wire.recordSha256 !== 'string' ||
      typeof wire.cms !== 'string' ||
      typeof wire.timestampTime !== 'string' ||
      typeof wire.keyId !== 'string'
    )
      return failed('bad_answer');
    // The record must say what was asked: this document, workflow, `seq` and head, and no more.
    let signed: Record<string, unknown>;
    try {
      signed = JSON.parse(wire.record) as Record<string, unknown>;
    } catch {
      return failed('bad_answer');
    }
    const members = Object.keys(signed).sort().join(',');
    if (
      members !== 'chainHead,document,format,seq,tenant,workflow' ||
      signed['chainHead'] !== job.chainHead ||
      signed['document'] !== job.documentId ||
      signed['seq'] !== job.seq ||
      signed['tenant'] !== job.tenant ||
      signed['workflow'] !== job.workflow
    )
      return failed('record_differs');
    const recordSha256 = sha256Hex(new TextEncoder().encode(wire.record));
    if (recordSha256 !== wire.recordSha256) return failed('hash_differs');
    const when = new Date(wire.timestampTime);
    if (Number.isNaN(when.getTime())) return failed('bad_answer');
    const cms = new Uint8Array(Buffer.from(wire.cms, 'base64'));
    if (cms.length === 0) return failed('bad_answer');
    return {
      ok: true,
      record: wire.record,
      recordSha256,
      cms,
      timestampTime: when,
      keyId: wire.keyId,
    };
  }

  async extend(job: ExtendJob): Promise<ExtendAttempt> {
    const unavailable = (code: string): ExtendAttempt => ({
      ok: false,
      reason: 'signing_unavailable',
      code,
      retryable: true,
    });
    const failed = (code: string): ExtendAttempt => ({
      ok: false,
      reason: 'seal_failed',
      code,
      retryable: false,
    });
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.url}/v1/extend`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#o.credential}`,
        },
        body: JSON.stringify({
          tenant: job.tenant,
          documentId: job.documentId,
          seq: job.seq,
          pdf: Buffer.from(job.pdf).toString('base64'),
          pdfSha256: sha256Hex(job.pdf),
          idempotencyKey: job.idempotencyKey,
          validation: job.validation,
        }),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      return unavailable('unreachable');
    }
    let wire: ExtendWire;
    try {
      wire = (await res.json()) as ExtendWire;
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
    if (
      typeof wire.pdf !== 'string' ||
      typeof wire.sealedSha256 !== 'string' ||
      typeof wire.timestampTime !== 'string' ||
      typeof wire.expiresAtMs !== 'number'
    )
      return failed('bad_answer');
    const extended = new Uint8Array(Buffer.from(wire.pdf, 'base64'));
    const sealedHash = sha256Hex(extended);
    const when = new Date(wire.timestampTime);
    if (sealedHash !== wire.sealedSha256) return failed('hash_differs');
    if (Number.isNaN(when.getTime()) || !Number.isFinite(wire.expiresAtMs))
      return failed('bad_answer');
    // The update only appends: the bytes that were sent are the first bytes that come back. A
    // repeat of a request the service has served returns its first result, which is the bytes
    // that were sent when that result is already the newest stored.
    const replay = Buffer.compare(Buffer.from(extended), Buffer.from(job.pdf)) === 0;
    if (
      !replay &&
      (extended.length <= job.pdf.length ||
        Buffer.compare(Buffer.from(extended.subarray(0, job.pdf.length)), Buffer.from(job.pdf)) !==
          0)
    )
      return failed('not_an_append');
    return {
      ok: true,
      pdf: extended,
      sealedHash,
      timestampTime: when,
      expiresAtMs: wire.expiresAtMs,
    };
  }
}

interface ExtendWire {
  ok?: unknown;
  code?: unknown;
  retryable?: unknown;
  pdf?: unknown;
  sealedSha256?: unknown;
  timestampTime?: unknown;
  expiresAtMs?: unknown;
}

interface AnchorWire {
  ok?: unknown;
  code?: unknown;
  retryable?: unknown;
  record?: unknown;
  recordSha256?: unknown;
  cms?: unknown;
  timestampTime?: unknown;
  keyId?: unknown;
}
