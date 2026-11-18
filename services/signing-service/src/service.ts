/**
 * The signing service (12 §8.2 step 3, §8.3; FRW-052, FRW-053), without a transport.
 *
 * What it does for one request to seal:
 *
 * 1. Authenticates the caller by its service credential and lets only the document service seal.
 * 2. Counts the request against the caller's rate limit.
 * 3. Checks the binding: the request names a document, a `seq` and the SHA-256 of the PDF; the
 *    bytes must hash to that value, both compiles of the pair (EXP-079) must have produced that
 *    hash, and one document and `seq` is bound to one hash for as long as the process lives.
 * 4. Writes the request to the audit log before any key is used.
 * 5. Selects the sealing key of the tenant from configuration (`selectSealingKey`) and seals at the
 *    profile the workflow names (`finalisation.seal`; PAdES B-LT when it names none, owner
 *    decision 15 of 2026-11-15).
 * 6. Returns the sealed bytes only when the seal carries a time-stamp token. A time-stamp
 *    authority that does not answer gives no seal at all (FRW-053 criterion 5).
 *
 * The key service, the certificate source, the time-stamp source and the validation data are
 * ports. The production choice of each is not made (owner decisions 221 to 223); the development
 * and test ones are SoftHSM2 in Podman, a test chain and a local authority (ADR 0411).
 *
 * Not here: the transport (`http.ts`), the persistence of the document and `seq` binding (it is in
 * memory, so a restart forgets it), and the delivery of an alert, which is the caller's.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { checkSealRequest, selectSealingKey, type SealingConfig } from '@docedit/authority';
import type { AuditEntry, AuditEvent, AuditSink } from './audit.ts';
import type { TimestampSource } from './cms.ts';
import type { KeyService } from './keyservice.ts';
import { sealPdf, type PadesProfile, type ValidationData } from './pades.ts';
import { FixedWindowLimiter, type RateLimit } from './rate-limit.ts';

/** The key services of the deployment, by key identifier. */
export interface KeyDirectory {
  get(keyId: string): KeyService | undefined;
}

/** The sealing certificate and its issuers, by key identifier (DER, the certificate first). */
export interface CertificateSource {
  chainFor(keyId: string): Promise<readonly Uint8Array[]>;
}

export interface SigningServiceConfig {
  /** The operator's key and the tenants that have their own (`selectSealingKey`). */
  readonly sealing: SealingConfig;
  readonly keys: KeyDirectory;
  readonly certificates: CertificateSource;
  readonly timestamps: TimestampSource;
  /** Validation data for B-LT and B-LTA, collected at sealing. */
  readonly validationData: (
    keyId: string,
    timestampCertificates: readonly Uint8Array[],
  ) => ValidationData;
  /**
   * The credentials, by the lower-case hexadecimal SHA-256 of the secret, each naming its caller.
   * The service keeps no secret, only hashes.
   */
  readonly callers: Readonly<Record<string, string>>;
  /** The one caller that may seal: the document service. */
  readonly allowedCaller: string;
  readonly rateLimit: RateLimit;
  readonly audit: AuditSink;
  /** The service's own clock: the time in `/M` and in the audit log. */
  readonly now?: () => Date;
  /** Room for a signature in `/Contents`, in bytes (`sealPdf`). */
  readonly contentsBytes?: number;
}

/** What the document service sends. */
export interface SealCommand {
  readonly tenant: string;
  readonly documentId: string;
  readonly seq: number;
  /** Lower-case hexadecimal SHA-256 of `pdf`. */
  readonly pdfSha256: string;
  /** The hashes of the two compiles that EXP-079 compared; both must equal `pdfSha256`. */
  readonly compileSha256: readonly [string, string];
  readonly pdf: Uint8Array;
  /** The workflow's `finalisation.seal`: `pades-b-lt` or `pades-b-lta`. Absent means B-LT. */
  readonly seal?: string | undefined;
}

export type SealFailureCode =
  | 'unauthenticated'
  | 'wrong_caller'
  | 'rate_limited'
  | 'bad_request'
  | 'hash_mismatch'
  | 'pair_differs'
  | 'binding_conflict'
  | 'unknown_seal_level'
  | 'no_key'
  | 'signing_unavailable'
  | 'tsa_unreachable'
  | 'audit_unavailable'
  | 'seal_failed';

export type SealOutcome =
  | {
      readonly ok: true;
      readonly pdf: Uint8Array;
      /** Lower-case hexadecimal SHA-256 of `pdf`. */
      readonly sealedSha256: string;
      readonly profile: PadesProfile;
      /** The time of the signature's time-stamp token (`genTime`): the seal's time. */
      readonly timestampTime: Date;
      /** The service's clock when it sealed: the time in `/M`. */
      readonly sealedAt: Date;
      readonly keyId: string;
      readonly keyOwner: 'operator' | 'tenant';
    }
  | {
      readonly ok: false;
      readonly code: SealFailureCode;
      /** Whether asking again later can succeed. */
      readonly retryable: boolean;
    };

const HEX64 = /^[0-9a-f]{64}$/;

const RETRYABLE: ReadonlySet<SealFailureCode> = new Set([
  'rate_limited',
  'signing_unavailable',
  'tsa_unreachable',
  'audit_unavailable',
]);

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The PAdES level a `finalisation.seal` value names, or null for a value the service does not know. */
export function profileOf(seal: string | undefined): PadesProfile | null {
  if (seal === undefined) return 'B-LT';
  if (seal === 'pades-b-lt') return 'B-LT';
  if (seal === 'pades-b-lta') return 'B-LTA';
  return null;
}

/** Marks a failure of the key service, so that it is not mistaken for a failure of the file. */
class KeyServiceFailure extends Error {}
/** Marks a failure of the time-stamp authority. */
class TimestampFailure extends Error {}

export class SigningService {
  readonly #cfg: SigningServiceConfig;
  readonly #limiter: FixedWindowLimiter;
  readonly #now: () => Date;
  readonly #credentials: readonly { hash: Buffer; caller: string }[];
  /** `documentId` and `seq` to the one hash that may be sealed for them. */
  readonly #bound = new Map<string, string>();

  constructor(cfg: SigningServiceConfig) {
    this.#cfg = cfg;
    this.#now = cfg.now ?? (() => new Date());
    this.#limiter = new FixedWindowLimiter(cfg.rateLimit, () => this.#now().getTime());
    this.#credentials = Object.entries(cfg.callers).map(([hex, caller]) => {
      if (!HEX64.test(hex)) throw new RangeError('a caller credential must be a SHA-256 hash');
      return { hash: Buffer.from(hex, 'hex'), caller };
    });
  }

  /** The caller a secret belongs to, or null. The comparison does not stop at the first byte. */
  #authenticate(secret: string | null): string | null {
    if (secret === null || secret.length === 0) return null;
    const given = createHash('sha256').update(secret).digest();
    let found: string | null = null;
    for (const c of this.#credentials) if (timingSafeEqual(given, c.hash)) found = c.caller;
    return found;
  }

  async #audit(event: AuditEvent, f: Partial<Omit<AuditEntry, 'at' | 'event'>>): Promise<boolean> {
    try {
      await this.#cfg.audit.append({
        at: this.#now().toISOString(),
        event,
        caller: f.caller ?? null,
        tenant: f.tenant ?? null,
        documentId: f.documentId ?? null,
        seq: f.seq ?? null,
        pdfSha256: f.pdfSha256 ?? null,
        keyId: f.keyId ?? null,
        sealedSha256: f.sealedSha256 ?? null,
        code: f.code ?? null,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Seals one PDF for the caller whose secret is `secret` (the bearer value of the request).
   * Never throws for a problem of the request or of a port: the outcome says what happened.
   */
  async seal(secret: string | null, cmd: SealCommand): Promise<SealOutcome> {
    const caller = this.#authenticate(secret);
    const ids = {
      caller,
      tenant: cmd.tenant,
      documentId: cmd.documentId,
      seq: cmd.seq,
      pdfSha256: cmd.pdfSha256,
    };
    const refuse = async (code: SealFailureCode): Promise<SealOutcome> => {
      await this.#audit('seal.refused', { ...ids, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };

    if (caller === null) return refuse('unauthenticated');
    // The limit is per caller and counts every request that names a known caller, wrong ones too.
    if (!this.#limiter.take(caller)) return refuse('rate_limited');
    if (caller !== this.#cfg.allowedCaller) return refuse('wrong_caller');

    if (
      cmd.tenant.length === 0 ||
      cmd.documentId.length === 0 ||
      !Number.isSafeInteger(cmd.seq) ||
      cmd.seq < 0 ||
      !HEX64.test(cmd.pdfSha256) ||
      cmd.compileSha256.length !== 2 ||
      !cmd.compileSha256.every((h) => HEX64.test(h)) ||
      cmd.pdf.length === 0
    )
      return refuse('bad_request');

    // The binding: the bytes are the bytes the request names, and the pair agrees with them.
    const actual = sha256Hex(cmd.pdf);
    const verdict = checkSealRequest(
      { caller, documentId: cmd.documentId, seq: cmd.seq, pdfSha256: cmd.pdfSha256 },
      { documentId: cmd.documentId, seq: cmd.seq, pdfSha256: actual },
      this.#cfg.allowedCaller,
    );
    if (!verdict.ok) return refuse('hash_mismatch');
    if (cmd.compileSha256[0] !== actual || cmd.compileSha256[1] !== actual)
      return refuse('pair_differs');
    const bindKey = `${cmd.documentId}\u0000${cmd.seq}`;
    const bound = this.#bound.get(bindKey);
    if (bound !== undefined && bound !== actual) return refuse('binding_conflict');

    const profile = profileOf(cmd.seal);
    if (profile === null) return refuse('unknown_seal_level');

    let key;
    try {
      key = selectSealingKey(this.#cfg.sealing, cmd.tenant);
    } catch {
      return refuse('no_key');
    }
    const keyService = this.#cfg.keys.get(key.keyId);
    if (keyService === undefined) return refuse('no_key');

    // The request is on record before any key is used. Without the record there is no seal.
    if (!(await this.#audit('seal.requested', { ...ids, keyId: key.keyId })))
      return { ok: false, code: 'audit_unavailable', retryable: true };

    const fail = async (code: SealFailureCode): Promise<SealOutcome> => {
      await this.#audit('seal.failed', { ...ids, keyId: key.keyId, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };

    const sealedAt = this.#now();
    try {
      const chain = await this.#cfg.certificates.chainFor(key.keyId).catch((e: unknown) => {
        throw new KeyServiceFailure(String(e));
      });
      const result = await sealPdf(cmd.pdf, {
        keyService: {
          keyLabel: keyService.keyLabel,
          publicKey: () => keyService.publicKey(),
          signDigest: (a, d) =>
            keyService.signDigest(a, d).catch((e: unknown) => {
              throw new KeyServiceFailure(String(e));
            }),
        },
        chain,
        timestamps: {
          stamp: (d) =>
            this.#cfg.timestamps.stamp(d).catch((e: unknown) => {
              throw new TimestampFailure(String(e));
            }),
        },
        profile,
        validationData: (tsCerts) => this.#cfg.validationData(key.keyId, tsCerts),
        signingTime: sealedAt,
        reason:
          key.owner === 'operator'
            ? 'Seal applied by the operator of the service. It is not the signature of any signer.'
            : 'Seal applied by the tenant. It is not the signature of any signer.',
        ...(this.#cfg.contentsBytes !== undefined
          ? { contentsBytes: this.#cfg.contentsBytes }
          : {}),
      });
      const sealedSha256 = sha256Hex(result.pdf);
      this.#bound.set(bindKey, actual);
      if (
        !(await this.#audit('seal.sealed', {
          ...ids,
          keyId: key.keyId,
          sealedSha256,
        }))
      )
        return { ok: false, code: 'audit_unavailable', retryable: true };
      return {
        ok: true,
        pdf: result.pdf,
        sealedSha256,
        profile,
        timestampTime: result.timestampTime,
        sealedAt,
        keyId: key.keyId,
        keyOwner: key.owner,
      };
    } catch (e) {
      if (e instanceof TimestampFailure) return fail('tsa_unreachable');
      if (e instanceof KeyServiceFailure) return fail('signing_unavailable');
      // A PdfError (a file the code cannot seal, a signature that does not fit) or anything else.
      return fail('seal_failed');
    }
  }
}
