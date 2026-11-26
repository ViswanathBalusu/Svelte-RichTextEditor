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
import {
  checkSealRequest,
  planAppearances,
  selectSealingKey,
  validateLayout,
  type AppearanceDiagnostic,
  type SealingConfig,
} from '@docedit/authority';
import type { AuditEntry, AuditEvent, AuditSink } from './audit.ts';
import {
  buildCms,
  certificateOf,
  cmsSignatureToken,
  timestampInfo,
  type TimestampSource,
} from './cms.ts';
import type { KeyService, ProviderAssertion } from './keyservice.ts';
import {
  extendPdf,
  sealPdf,
  type AppearanceItem,
  type PadesProfile,
  type ValidationData,
} from './pades.ts';
import { PdfDocument } from './pdf.ts';
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
  /** Visible appearances at the signature and initials fields (FRW-057). Absent: none are drawn. */
  readonly appearances?: AppearanceRequest | undefined;
}

/**
 * What to draw at the fields (FRW-057). The layout is the `fields` member of `layout.json`: field
 * identifier to page and rectangle, in twentieths of a point from the top-left corner of the page.
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

/** What was drawn, and what was not and why (FRW-057 criterion 6). */
export interface AppearanceReport {
  readonly drawn: readonly string[];
  readonly diagnostics: readonly AppearanceDiagnostic[];
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
      /**
       * The end of the newest time-stamp's validity (the authority certificate's `notAfter`), ms
       * since the epoch: when the first renewal is due (FRW-056). Absent when it cannot be read.
       */
      readonly expiresAtMs?: number;
      /** The service's clock when it sealed: the time in `/M`. */
      readonly sealedAt: Date;
      readonly keyId: string;
      readonly keyOwner: 'operator' | 'tenant';
      /** Present when appearances were asked for. */
      readonly appearances?: AppearanceReport;
      /**
       * Present when a signature provider holds the key (FRW-059): what the provider asserts about
       * its level and the signer. Asserted, not verified.
       */
      readonly provider?: ProviderAssertion;
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

/** `expiresAtMs` from the authority certificate (first) of a time-stamp token; nothing if unreadable. */
function expiryOf(certs: readonly Uint8Array[]): { expiresAtMs?: number } {
  const der = certs[0];
  if (der === undefined) return {};
  try {
    const t = certificateOf(der).notAfter.value.getTime();
    return Number.isFinite(t) ? { expiresAtMs: t } : {};
  } catch {
    return {};
  }
}

/** The PAdES level a `finalisation.seal` value names, or null for a value the service does not know. */
export function profileOf(seal: string | undefined): PadesProfile | null {
  if (seal === undefined) return 'B-LT';
  if (seal === 'pades-b-lt') return 'B-LT';
  if (seal === 'pades-b-lta') return 'B-LTA';
  return null;
}

/**
 * The appearances to draw in `pdf` (FRW-057): the layout's `fields` are checked (`validateLayout`),
 * converted from twips from the top-left to points from the lower-left of each page's box, and
 * planned against the page sizes (`planAppearances`), so that a rectangle outside its page is not
 * used. Never throws: a PDF whose pages cannot be read gives a diagnostic for every target, and the
 * seal goes on without appearances.
 */
export function planFieldAppearances(
  pdf: Uint8Array,
  req: AppearanceRequest,
): { items: AppearanceItem[]; report: AppearanceReport } {
  const wanted = req.targets.map((t) => ({ id: t.id, key: t.key, kind: t.kind }));
  let pages: ReturnType<PdfDocument['pageList']>;
  try {
    pages = new PdfDocument(pdf).pageList();
  } catch {
    const plan = planAppearances(null, wanted, []);
    return { items: [], report: { drawn: [], diagnostics: plan.diagnostics } };
  }
  const checked = validateLayout({ fields: req.layout });
  const converted: Record<string, { page: number; rect: [number, number, number, number] }> = {};
  const origin = new Map<number, [number, number]>();
  if (checked.ok)
    for (const [id, e] of checked.fields) {
      const box = pages[e.page - 1]?.mediaBox ?? null;
      if (box === null) {
        // No such page: leave the entry as it is so that the plan reports the page.
        converted[id] = { page: e.page, rect: [e.rect[0], e.rect[1], e.rect[2], e.rect[3]] };
        continue;
      }
      const height = box[3] - box[1];
      origin.set(e.page, [box[0], box[1]]);
      converted[id] = {
        page: e.page,
        rect: [e.rect[0] / 20, height - e.rect[3] / 20, e.rect[2] / 20, height - e.rect[1] / 20],
      };
    }
  const bounds = pages.map((p, i) => ({
    page: i + 1,
    width: p.mediaBox === null ? 0 : p.mediaBox[2] - p.mediaBox[0],
    height: p.mediaBox === null ? 0 : p.mediaBox[3] - p.mediaBox[1],
  }));
  const plan = planAppearances(
    checked.ok ? { fields: converted } : { fields: req.layout },
    wanted,
    bounds,
  );
  // A layout the file's own validator accepted may still hold an entry the plan drops: report it.
  const lines = new Map(req.targets.map((t) => [t.id, t.lines]));
  const items = plan.appearances.map((a): AppearanceItem => {
    const [ox, oy] = origin.get(a.page) ?? [0, 0];
    return {
      page: a.page,
      rect: [a.rect[0] + ox, a.rect[1] + oy, a.rect[2] + ox, a.rect[3] + oy],
      lines: lines.get(a.id) ?? [],
      label: `Signature field ${a.key}`,
    };
  });
  // The entries `validateLayout` dropped are reported too: the plan saw only the ones it kept.
  const dropped: AppearanceDiagnostic[] = checked.ok
    ? checked.problems.map((p) => ({
        id: p.id,
        key: '',
        code: 'entry_invalid' as const,
        reason: `layout entry not used: ${p.reason}`,
      }))
    : [];
  return {
    items,
    report: {
      drawn: plan.appearances.map((a) => a.id),
      diagnostics: [...dropped, ...plan.diagnostics],
    },
  };
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
  /** Results served, by document and idempotency key (in memory: a restart forgets them). */
  readonly #extended = new Map<string, ExtendOutcome>();

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
        // Only an anchor entry has the member, so the entries of a seal are as they were.
        ...(f.chainHead !== undefined ? { chainHead: f.chainHead } : {}),
        // Only the entry of a batch of heads has this one (HIS-036).
        ...(f.batchRoot !== undefined ? { batchRoot: f.batchRoot } : {}),
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
      const drawing = cmd.appearances ? planFieldAppearances(cmd.pdf, cmd.appearances) : null;
      const result = await sealPdf(cmd.pdf, {
        ...(drawing && drawing.items.length > 0 ? { appearances: drawing.items } : {}),
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
      // A key held by a signature provider says what the provider asserts about it (FRW-059). It was
      // read when the certificate was; a failure to read it again is not a failed seal.
      const provider = await keyService.assertion?.().catch(() => undefined);
      return {
        ok: true,
        pdf: result.pdf,
        sealedSha256,
        profile,
        timestampTime: result.timestampTime,
        ...expiryOf(result.tokenCertificates),
        sealedAt,
        keyId: key.keyId,
        keyOwner: key.owner,
        ...(drawing ? { appearances: drawing.report } : {}),
        ...(provider ? { provider } : {}),
      };
    } catch (e) {
      if (e instanceof TimestampFailure) return fail('tsa_unreachable');
      if (e instanceof KeyServiceFailure) return fail('signing_unavailable');
      // A PdfError (a file the code cannot seal, a signature that does not fit) or anything else.
      return fail('seal_failed');
    }
  }

  /**
   * Signs and time-stamps the chain head of a workflow at completion (FRW-054 criterion 3; 08 §12).
   * The same rules as `seal`: the caller's credential, the rate limit, the audit entry before any
   * key is used, the key of the tenant, no answer without a time-stamp token. The signed record is
   * the canonical text `anchorRecordText` gives; the signature is a detached CAdES-B-T over its
   * SHA-256, with an RFC 3161 token over the signature value. One document and `seq` is bound to
   * one chain head for as long as the process lives (the same bytes again anchor again).
   */
  async anchor(secret: string | null, cmd: AnchorCommand): Promise<AnchorOutcome> {
    const caller = this.#authenticate(secret);
    const ids = {
      caller,
      tenant: cmd.tenant,
      documentId: cmd.documentId,
      seq: cmd.seq,
      chainHead: cmd.chainHead,
    };
    const refuse = async (code: SealFailureCode): Promise<AnchorOutcome> => {
      await this.#audit('anchor.refused', { ...ids, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };
    if (caller === null) return refuse('unauthenticated');
    if (!this.#limiter.take(caller)) return refuse('rate_limited');
    if (caller !== this.#cfg.allowedCaller) return refuse('wrong_caller');
    if (
      cmd.tenant.length === 0 ||
      cmd.documentId.length === 0 ||
      cmd.workflow.length === 0 ||
      !Number.isSafeInteger(cmd.seq) ||
      cmd.seq < 0 ||
      !HEX64.test(cmd.chainHead)
    )
      return refuse('bad_request');
    const bindKey = `anchor\u0000${cmd.documentId}\u0000${cmd.seq}`;
    const bound = this.#bound.get(bindKey);
    if (bound !== undefined && bound !== cmd.chainHead) return refuse('binding_conflict');

    let key;
    try {
      key = selectSealingKey(this.#cfg.sealing, cmd.tenant);
    } catch {
      return refuse('no_key');
    }
    const keyService = this.#cfg.keys.get(key.keyId);
    if (keyService === undefined) return refuse('no_key');
    if (!(await this.#audit('anchor.requested', { ...ids, keyId: key.keyId })))
      return { ok: false, code: 'audit_unavailable', retryable: true };

    const fail = async (code: SealFailureCode): Promise<AnchorOutcome> => {
      await this.#audit('anchor.failed', { ...ids, keyId: key.keyId, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };
    const anchoredAt = this.#now();
    try {
      const chain = await this.#cfg.certificates.chainFor(key.keyId).catch((e: unknown) => {
        throw new KeyServiceFailure(String(e));
      });
      const record = anchorRecordText(cmd);
      const recordSha256 = sha256Hex(new TextEncoder().encode(record));
      const cms = await buildCms({
        keyService: {
          keyLabel: keyService.keyLabel,
          publicKey: () => keyService.publicKey(),
          signDigest: (a, d) =>
            keyService.signDigest(a, d).catch((e: unknown) => {
              throw new KeyServiceFailure(String(e));
            }),
        },
        chain,
        contentDigest: Buffer.from(recordSha256, 'hex'),
        timestamps: {
          stamp: (d) =>
            this.#cfg.timestamps.stamp(d).catch((e: unknown) => {
              throw new TimestampFailure(String(e));
            }),
        },
      });
      const timestampTime = signatureTimestampTime(cms);
      this.#bound.set(bindKey, cmd.chainHead);
      if (
        !(await this.#audit('anchor.anchored', {
          ...ids,
          keyId: key.keyId,
          sealedSha256: recordSha256,
        }))
      )
        return { ok: false, code: 'audit_unavailable', retryable: true };
      return {
        ok: true,
        record,
        recordSha256,
        cms,
        timestampTime,
        anchoredAt,
        keyId: key.keyId,
        keyOwner: key.owner,
      };
    } catch (e) {
      if (e instanceof TimestampFailure) return fail('tsa_unreachable');
      if (e instanceof KeyServiceFailure) return fail('signing_unavailable');
      return fail('seal_failed');
    }
  }
  /**
   * Signs and time-stamps the hourly batch of a tenant's chain heads (HIS-036; 08 §12; ADR 0409):
   * one record that names the root of a Merkle tree over the heads. The same rules as `anchor`: the
   * caller's credential, the rate limit, the audit entry before any key is used, the key of the
   * tenant, no answer without a time-stamp token. The signed record is the canonical text
   * `batchAnchorRecordText` gives; the signature is a detached CAdES-B-T over its SHA-256, with an
   * RFC 3161 token over the signature value. One tenant and `to` is bound to one root for as long
   * as the process lives. The service sees a root and a count, never a head or a document.
   */
  async anchorBatch(secret: string | null, cmd: BatchAnchorCommand): Promise<AnchorOutcome> {
    const caller = this.#authenticate(secret);
    const ids = { caller, tenant: cmd.tenant, batchRoot: cmd.root };
    const refuse = async (code: SealFailureCode): Promise<AnchorOutcome> => {
      await this.#audit('anchor.refused', { ...ids, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };
    if (caller === null) return refuse('unauthenticated');
    if (!this.#limiter.take(caller)) return refuse('rate_limited');
    if (caller !== this.#cfg.allowedCaller) return refuse('wrong_caller');
    const record = batchAnchorRecordText(cmd);
    if (record === null) return refuse('bad_request');
    const bindKey = `anchor-batch\u0000${cmd.tenant}\u0000${cmd.to}`;
    const bound = this.#bound.get(bindKey);
    if (bound !== undefined && bound !== record) return refuse('binding_conflict');

    let key;
    try {
      key = selectSealingKey(this.#cfg.sealing, cmd.tenant);
    } catch {
      return refuse('no_key');
    }
    const keyService = this.#cfg.keys.get(key.keyId);
    if (keyService === undefined) return refuse('no_key');
    if (!(await this.#audit('anchor.requested', { ...ids, keyId: key.keyId })))
      return { ok: false, code: 'audit_unavailable', retryable: true };

    const fail = async (code: SealFailureCode): Promise<AnchorOutcome> => {
      await this.#audit('anchor.failed', { ...ids, keyId: key.keyId, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };
    const anchoredAt = this.#now();
    try {
      const chain = await this.#cfg.certificates.chainFor(key.keyId).catch((e: unknown) => {
        throw new KeyServiceFailure(String(e));
      });
      const recordSha256 = sha256Hex(new TextEncoder().encode(record));
      const cms = await buildCms({
        keyService: {
          keyLabel: keyService.keyLabel,
          publicKey: () => keyService.publicKey(),
          signDigest: (a, d) =>
            keyService.signDigest(a, d).catch((e: unknown) => {
              throw new KeyServiceFailure(String(e));
            }),
        },
        chain,
        contentDigest: Buffer.from(recordSha256, 'hex'),
        timestamps: {
          stamp: (d) =>
            this.#cfg.timestamps.stamp(d).catch((e: unknown) => {
              throw new TimestampFailure(String(e));
            }),
        },
      });
      const timestampTime = signatureTimestampTime(cms);
      this.#bound.set(bindKey, record);
      if (
        !(await this.#audit('anchor.anchored', {
          ...ids,
          keyId: key.keyId,
          sealedSha256: recordSha256,
        }))
      )
        return { ok: false, code: 'audit_unavailable', retryable: true };
      return {
        ok: true,
        record,
        recordSha256,
        cms,
        timestampTime,
        anchoredAt,
        keyId: key.keyId,
        keyOwner: key.owner,
      };
    } catch (e) {
      if (e instanceof TimestampFailure) return fail('tsa_unreachable');
      if (e instanceof KeyServiceFailure) return fail('signing_unavailable');
      return fail('seal_failed');
    }
  }

  /**
   * Extends a sealed PDF for long-term validation and renews its time-stamp (12 §8.2 step 5;
   * FRW-056): fresh validation data when asked, and a further document time-stamp, both as
   * incremental updates. The same rules as `seal`: the caller's credential, the rate limit, the
   * audit entry before the work, the hash of the bytes, no answer without a token. A request with an
   * `idempotencyKey` already served returns the result it had and adds nothing.
   */
  async extend(secret: string | null, cmd: ExtendCommand): Promise<ExtendOutcome> {
    const caller = this.#authenticate(secret);
    const ids = {
      caller,
      tenant: cmd.tenant,
      documentId: cmd.documentId,
      seq: cmd.seq,
      pdfSha256: cmd.pdfSha256,
    };
    const refuse = async (code: SealFailureCode): Promise<ExtendOutcome> => {
      await this.#audit('extend.refused', { ...ids, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };
    if (caller === null) return refuse('unauthenticated');
    if (!this.#limiter.take(caller)) return refuse('rate_limited');
    if (caller !== this.#cfg.allowedCaller) return refuse('wrong_caller');
    if (
      cmd.tenant.length === 0 ||
      cmd.documentId.length === 0 ||
      cmd.idempotencyKey.length === 0 ||
      !Number.isSafeInteger(cmd.seq) ||
      cmd.seq < 0 ||
      !HEX64.test(cmd.pdfSha256) ||
      cmd.pdf.length === 0
    )
      return refuse('bad_request');
    if (sha256Hex(cmd.pdf) !== cmd.pdfSha256) return refuse('hash_mismatch');
    const served = this.#extended.get(`${cmd.documentId}\u0000${cmd.idempotencyKey}`);
    if (served !== undefined) return served;
    let key;
    try {
      key = selectSealingKey(this.#cfg.sealing, cmd.tenant);
    } catch {
      return refuse('no_key');
    }
    if (!(await this.#audit('extend.requested', { ...ids, keyId: key.keyId })))
      return { ok: false, code: 'audit_unavailable', retryable: true };
    const fail = async (code: SealFailureCode): Promise<ExtendOutcome> => {
      await this.#audit('extend.failed', { ...ids, keyId: key.keyId, code });
      return { ok: false, code, retryable: RETRYABLE.has(code) };
    };
    const extendedAt = this.#now();
    try {
      const result = await extendPdf(cmd.pdf, {
        timestamps: {
          stamp: (d) =>
            this.#cfg.timestamps.stamp(d).catch((e: unknown) => {
              throw new TimestampFailure(String(e));
            }),
        },
        ...(cmd.validation
          ? { validationData: (certs) => this.#cfg.validationData(key.keyId, certs) }
          : {}),
        time: extendedAt,
        ...(this.#cfg.contentsBytes !== undefined
          ? { contentsBytes: this.#cfg.contentsBytes }
          : {}),
      });
      const sealedSha256 = sha256Hex(result.pdf);
      const expiry = certificateOf(result.tokenCertificates[0] ?? new Uint8Array()).notAfter.value;
      const outcome: ExtendOutcome = {
        ok: true,
        pdf: result.pdf,
        sealedSha256,
        timestampTime: result.timestampTime,
        extendedAt,
        expiresAtMs: expiry.getTime(),
        validationAdded: cmd.validation,
      };
      this.#extended.set(`${cmd.documentId}\u0000${cmd.idempotencyKey}`, outcome);
      if (!(await this.#audit('extend.extended', { ...ids, keyId: key.keyId, sealedSha256 })))
        return { ok: false, code: 'audit_unavailable', retryable: true };
      return outcome;
    } catch (e) {
      if (e instanceof TimestampFailure) return fail('tsa_unreachable');
      return fail('seal_failed');
    }
  }
}

/** What the document service sends to extend a sealed PDF. */
export interface ExtendCommand {
  readonly tenant: string;
  readonly documentId: string;
  readonly seq: number;
  /** The newest sealed bytes the document service holds. */
  readonly pdf: Uint8Array;
  readonly pdfSha256: string;
  /** One request, one result: a repeat with the same key returns the first result. */
  readonly idempotencyKey: string;
  /** Add fresh validation data (a new DSS) before the time-stamp. */
  readonly validation: boolean;
}

export type ExtendOutcome =
  | {
      readonly ok: true;
      /** The input, then the update. */
      readonly pdf: Uint8Array;
      readonly sealedSha256: string;
      /** `genTime` of the appended document time-stamp. */
      readonly timestampTime: Date;
      readonly extendedAt: Date;
      /** The end of the new time-stamp's validity: the authority certificate's `notAfter`, in ms. */
      readonly expiresAtMs: number;
      readonly validationAdded: boolean;
    }
  | { readonly ok: false; readonly code: SealFailureCode; readonly retryable: boolean };

/** What the document service sends to have a chain head anchored. */
export interface AnchorCommand {
  readonly tenant: string;
  readonly documentId: string;
  readonly workflow: string;
  /** The `seq` of the head: the workflow's `completedSeq`. */
  readonly seq: number;
  /** Lower-case hexadecimal SHA-256 chain head at `seq`. */
  readonly chainHead: string;
}

export type AnchorOutcome =
  | {
      readonly ok: true;
      /** The signed record, as canonical text. */
      readonly record: string;
      readonly recordSha256: string;
      /** A detached CAdES-B-T over `recordSha256` (DER). */
      readonly cms: Uint8Array;
      /** The time of the signature's time-stamp token (`genTime`). */
      readonly timestampTime: Date;
      readonly anchoredAt: Date;
      readonly keyId: string;
      readonly keyOwner: 'operator' | 'tenant';
    }
  | {
      readonly ok: false;
      readonly code: SealFailureCode;
      readonly retryable: boolean;
    };

/** The format name of the signed record. */
export const ANCHOR_FORMAT = 'docedit-chain-head-anchor/1';

/**
 * The record that is signed, as text: a JSON object with its members in alphabetical order and no
 * white space, so that a verifier rebuilds the same bytes from the members. It holds identifiers
 * and the head; no document content.
 */
export function anchorRecordText(c: AnchorCommand): string {
  return JSON.stringify({
    chainHead: c.chainHead,
    document: c.documentId,
    format: ANCHOR_FORMAT,
    seq: c.seq,
    tenant: c.tenant,
    workflow: c.workflow,
  });
}

/**
 * What the document service sends to have a batch of chain heads anchored (HIS-036; ADR 0409): the
 * root of the tree over the heads, not the heads.
 */
export interface BatchAnchorCommand {
  readonly tenant: string;
  /** The `to` of the tenant's previous record, or null for its first. RFC 3339, UTC, milliseconds. */
  readonly from: string | null;
  /** The time the heads were read. RFC 3339, UTC, milliseconds. */
  readonly to: string;
  /** The Merkle root, lower-case hexadecimal SHA-256. */
  readonly root: string;
  /** The number of leaves. */
  readonly leaves: number;
  /** The SHA-256 of the tenant's previous record text, or null for its first. */
  readonly previous: string | null;
}

/** The format name of the signed record of a batch. */
export const BATCH_ANCHOR_FORMAT = 'docedit-anchor/1';

const BATCH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The record of a batch that is signed, as text: a JSON object with its members in alphabetical
 * order and no white space, the same text `headAnchorRecordText` of `@docedit/history` gives, so
 * that the caller and a verifier rebuild the same bytes. Null when a member is not of its shape.
 * It holds a tenant, two times, a count and two hashes; no head, no document, no content.
 */
export function batchAnchorRecordText(c: BatchAnchorCommand): string | null {
  if (
    typeof c.tenant !== 'string' ||
    c.tenant.length === 0 ||
    typeof c.to !== 'string' ||
    !BATCH_TIME.test(c.to) ||
    (c.from !== null && (typeof c.from !== 'string' || !BATCH_TIME.test(c.from))) ||
    (c.from !== null && c.from >= c.to) ||
    typeof c.root !== 'string' ||
    !HEX64.test(c.root) ||
    !Number.isSafeInteger(c.leaves) ||
    c.leaves < 1 ||
    (c.previous !== null && (typeof c.previous !== 'string' || !HEX64.test(c.previous))) ||
    (c.from === null) !== (c.previous === null)
  )
    return null;
  return JSON.stringify({
    format: BATCH_ANCHOR_FORMAT,
    from: c.from,
    leaves: c.leaves,
    previous: c.previous,
    root: c.root,
    tenant: c.tenant,
    to: c.to,
  });
}

/** `genTime` of the signature time-stamp token inside a CMS the service made. */
function signatureTimestampTime(cms: Uint8Array): Date {
  const token = cmsSignatureToken(cms);
  if (token === null) throw new Error('the signature has no time-stamp token');
  return timestampInfo(token).genTime;
}
