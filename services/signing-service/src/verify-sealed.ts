/**
 * A verifier of a sealed PDF for a relying party (12 §8.2 step 4, §10; FRW-055 criterion 2).
 *
 * It needs the PDF and the roots the relying party trusts, and nothing from the service. For each
 * signature it finds by `/ByteRange` it checks:
 *
 * - the CMS signature over the signed byte ranges, including the message digest;
 * - the certificate chain from the signer to a trusted root, at the time of the time-stamp when the
 *   signature has one;
 * - the signature time-stamp token (RFC 3161): its own signature and chain, and that its imprint is
 *   the SHA-256 of the signature value; for a document time-stamp (`ETSI.RFC3161`), that the token
 *   is signed and chained and its imprint is the SHA-256 of the signed byte ranges.
 *
 * It does not check revocation, policy or what Acrobat checks beyond this; it does not decide who
 * the signer is. A byte changed in a signed range, in the signature or in the token gives `ok:
 * false` for that signature, and no signature that covers the file's last byte makes the report say
 * so (`coversWholeFile`): bytes after the last signature are not covered by it.
 *
 * Built on `pkijs`, not on the code that made the seal, and cross-checked against the OpenSSL
 * command line in the tests.
 */
import { createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { certificateOf, cmsSignatureToken, timestampInfo } from './cms.ts';

export interface SignatureReport {
  readonly kind: 'signature' | 'document-time-stamp';
  readonly subFilter: string;
  readonly byteRange: readonly [number, number, number, number];
  /** The signature covers the file up to its last byte. */
  readonly coversWholeFile: boolean;
  /** The signature value, the message digest and the signed attributes verify. */
  readonly signature: boolean;
  /** The signer's chain reaches a trusted root. */
  readonly chain: boolean;
  /** The time-stamp token verifies and its imprint is right; null when there is no token. */
  readonly timestamp: boolean | null;
  /** `genTime` of the token, or null. */
  readonly timestampTime: string | null;
  /** The signer's subject, for the reader; not an identity check. */
  readonly signer: string | null;
  /** Everything above is true (and the time-stamp is present for a PAdES B-T or better seal). */
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface SealedPdfReport {
  readonly ok: boolean;
  readonly signatures: readonly SignatureReport[];
  readonly problems: readonly string[];
  /** Bytes after the last signature's range: 0, or the validation data of a B-LT seal. */
  readonly bytesAfterLastSignature?: number;
}

const sha256 = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(b).digest());
const ab = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const equal = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

interface Found {
  readonly subFilter: string;
  readonly byteRange: [number, number, number, number];
  readonly contents: Uint8Array;
  readonly signed: Uint8Array;
}

/** The signatures of a PDF: the `/ByteRange` and `/Contents` of each signature dictionary. */
function findSignatures(pdf: Uint8Array): Found[] {
  const text = Buffer.from(pdf).toString('latin1');
  const found: Found[] = [];
  for (const m of text.matchAll(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/g)) {
    const r: [number, number, number, number] = [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
    ];
    // The signature dictionary names its sub-filter before its byte range.
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    const sub = /\/SubFilter\s*\/([A-Za-z0-9.]+)/.exec(before.slice(before.lastIndexOf('/Type')));
    if (r[1] < 1 || r[2] <= r[1] || r[2] + r[3] > pdf.length) continue;
    const hex = text.slice(r[1] + 1, r[2] - 1);
    if (!/^[0-9a-fA-F]+$/.test(hex)) continue;
    const all = Buffer.from(hex, 'hex');
    // The DER length of the CMS inside the padded `/Contents`.
    const l = all[1];
    if (all[0] !== 0x30 || l === undefined) continue;
    let head = 2;
    let len = l;
    if (l >= 0x80) {
      head = 2 + (l & 0x7f);
      len = 0;
      for (let i = 0; i < (l & 0x7f); i++) len = len * 256 + (all[2 + i] as number);
    }
    found.push({
      subFilter: sub?.[1] ?? '',
      byteRange: r,
      contents: new Uint8Array(all.subarray(0, head + len)),
      signed: new Uint8Array(
        Buffer.concat([
          Buffer.from(pdf.subarray(r[0], r[0] + r[1])),
          Buffer.from(pdf.subarray(r[2], r[2] + r[3])),
        ]),
      ),
    });
  }
  return found;
}

function signedDataOf(der: Uint8Array): pkijs.SignedData {
  const parsed = asn1js.fromBER(ab(der));
  if (parsed.offset === -1) throw new Error('not valid DER');
  return new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: parsed.result }).content });
}

/** The certificates a CMS carries. */
function certsOf(sd: pkijs.SignedData): pkijs.Certificate[] {
  return (sd.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
}

/**
 * Whether a CMS verifies: the signature and the signed attributes (with the message digest over
 * `data`, or over the content the CMS holds), and a chain from the signer to a trusted root at `at`.
 * The certificates the CMS carries serve as intermediates and are never trusted themselves.
 */
async function verifyCms(
  sd: pkijs.SignedData,
  data: Uint8Array | null,
  roots: readonly pkijs.Certificate[],
  at: Date | null,
  extra: readonly pkijs.Certificate[],
): Promise<{ signature: boolean; chain: boolean; reason: string }> {
  // For a time-stamp token pkijs checks the imprint of its TSTInfo against `data`, the bytes that
  // were stamped; for a detached signature it is the signed content.
  const sig = await sd
    .verify({
      signer: 0,
      checkChain: false,
      extendedMode: true,
      ...(data !== null ? { data: ab(data) } : {}),
    })
    .catch((e: unknown) => ({ signatureVerified: false, message: String(e) }));
  if ((sig as { signatureVerified?: boolean | null }).signatureVerified !== true)
    return {
      signature: false,
      chain: false,
      reason: (sig as { message?: string }).message ?? 'the signature does not verify',
    };
  const sid = sd.signerInfos[0]?.sid;
  const signerCert = certsOf(sd).find(
    (c) =>
      sid instanceof pkijs.IssuerAndSerialNumber &&
      c.issuer.isEqual(sid.issuer) &&
      c.serialNumber.isEqual(sid.serialNumber),
  );
  if (signerCert === undefined)
    return { signature: true, chain: false, reason: 'the signer certificate is not in the CMS' };
  const pool = [...certsOf(sd), ...extra].filter((c) => c !== signerCert);
  const engine = new pkijs.CertificateChainValidationEngine({
    certs: [...pool, signerCert],
    trustedCerts: [...roots],
    checkDate: at ?? new Date(),
  });
  const res = await engine
    .verify()
    .catch((e: unknown) => ({ result: false, resultMessage: String(e) }));
  return {
    signature: true,
    chain: res.result === true,
    reason: res.result === true ? '' : (res.resultMessage ?? 'the chain is not trusted'),
  };
}
export async function verifySealedPdf(
  pdf: Uint8Array,
  roots: readonly Uint8Array[],
): Promise<SealedPdfReport> {
  const trusted = roots.map(certificateOf);
  const found = findSignatures(pdf);
  if (found.length === 0)
    return { ok: false, signatures: [], problems: ['the PDF holds no signature'] };
  const signatures: SignatureReport[] = [];
  for (const f of found) {
    const problems: string[] = [];
    const coversWholeFile = f.byteRange[2] + f.byteRange[3] === pdf.length;
    let signer: string | null = null;
    let timestampTime: string | null = null;
    let signature = false;
    let chain = false;
    let timestamp: boolean | null = null;
    const kind = f.subFilter === 'ETSI.RFC3161' ? 'document-time-stamp' : 'signature';
    try {
      if (kind === 'document-time-stamp') {
        // The `/Contents` is the token itself; its imprint is the signed byte ranges.
        const info = timestampInfo(f.contents);
        timestampTime = info.genTime.toISOString();
        const r = await verifyCms(signedDataOf(f.contents), f.signed, trusted, info.genTime, []);
        signature = r.signature;
        chain = r.chain;
        if (!r.signature || !r.chain) problems.push(`time-stamp: ${r.reason}`);
        timestamp = signature && chain && equal(info.imprint, sha256(f.signed));
        if (!timestamp && signature && chain)
          problems.push('the time-stamp imprint is not the signed bytes');
      } else {
        const sd = signedDataOf(f.contents);
        const cert = (sd.certificates ?? []).find(
          (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
        );
        signer =
          cert?.subject.typesAndValues.map((t) => String(t.value.valueBlock.value)).join(', ') ??
          null;
        const token = cmsSignatureToken(f.contents);
        const at = token !== null ? timestampInfo(token).genTime : null;
        timestampTime = at?.toISOString() ?? null;
        const r = await verifyCms(sd, f.signed, trusted, at, []);
        signature = r.signature;
        chain = r.chain;
        if (!r.signature || !r.chain) problems.push(`signature: ${r.reason}`);
        if (token !== null) {
          const tsd = signedDataOf(token);
          const sigValue = new Uint8Array(sd.signerInfos[0]!.signature.valueBlock.valueHexView);
          const t = await verifyCms(tsd, sigValue, trusted, at, certsOf(sd));
          timestamp =
            t.signature && t.chain && equal(timestampInfo(token).imprint, sha256(sigValue));
          if (!timestamp)
            problems.push(`time-stamp: ${t.reason || 'the imprint is not the signature value'}`);
        }
      }
    } catch (e) {
      problems.push(`unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
    signatures.push({
      kind,
      subFilter: f.subFilter,
      byteRange: f.byteRange,
      coversWholeFile,
      signature,
      chain,
      timestamp,
      timestampTime,
      signer,
      ok: signature && chain && timestamp !== false && problems.length === 0,
      problems,
    });
  }
  // Bytes after the last signature are not covered by it. A B-LT seal appends its validation data
  // (the DSS) there, which is expected; any other tail is reported. What the update changes is not
  // analysed: a reader that must catch a changed page after the seal checks it with the PDF's own
  // incremental-update analysis (Acrobat does).
  const problems: string[] = [];
  const reach = Math.max(...found.map((f) => f.byteRange[2] + f.byteRange[3]));
  const tail = Buffer.from(pdf.subarray(reach)).toString('latin1');
  const validationDataOnly =
    tail.length === 0 || (/\/DSS\b/.test(tail) && !/\/Contents\s*</.test(tail));
  if (!validationDataOnly)
    problems.push('bytes follow the last signature and are not a validation data update');
  return {
    ok: signatures.every((s) => s.ok) && problems.length === 0,
    signatures,
    problems,
    bytesAfterLastSignature: pdf.length - reach,
  };
}
/** Roots from PEM or DER files' bytes: PEM blocks are read, anything else is taken as one DER. */
export function rootsOf(files: readonly Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const f of files) {
    const text = Buffer.from(f).toString('latin1');
    const blocks = [
      ...text.matchAll(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/g),
    ];
    if (blocks.length > 0)
      for (const b of blocks)
        out.push(new Uint8Array(Buffer.from(b[1]!.replace(/\s+/g, ''), 'base64')));
    else out.push(f);
  }
  return out;
}

export interface AnchorReport {
  readonly ok: boolean;
  /** The record as the file gives it, parsed; null when it is not JSON. */
  readonly record: {
    readonly chainHead: string;
    readonly document: string;
    readonly seq: number;
    readonly tenant: string;
    readonly workflow: string;
  } | null;
  readonly timestampTime: string | null;
  readonly problems: readonly string[];
}

/**
 * The signed, time-stamped chain head (FRW-054 criterion 3) as a relying party checks it: the
 * record's hash, the detached signature over it, the chain to a trusted root and the time-stamp
 * token over the signature value. Whether the head is the bundle's is the caller's comparison.
 */
export async function verifyAnchorFile(
  file: { record: string; recordSha256: string; cms: string },
  roots: readonly Uint8Array[],
): Promise<AnchorReport> {
  const problems: string[] = [];
  const bytes = new TextEncoder().encode(file.record);
  if (Buffer.from(sha256(bytes)).toString('hex') !== file.recordSha256)
    problems.push('the record does not hash to the stated SHA-256');
  let record: AnchorReport['record'] = null;
  try {
    const r = JSON.parse(file.record) as Record<string, unknown>;
    if (
      r['format'] === 'docedit-chain-head-anchor/1' &&
      typeof r['chainHead'] === 'string' &&
      typeof r['document'] === 'string' &&
      typeof r['seq'] === 'number' &&
      typeof r['tenant'] === 'string' &&
      typeof r['workflow'] === 'string'
    )
      record = r as unknown as NonNullable<AnchorReport['record']>;
    else problems.push('the record is not of the anchor format');
  } catch {
    problems.push('the record is not JSON');
  }
  let timestampTime: string | null = null;
  try {
    const trusted = roots.map(certificateOf);
    const cms = new Uint8Array(Buffer.from(file.cms, 'base64'));
    const sd = signedDataOf(cms);
    const token = cmsSignatureToken(cms);
    if (token === null) problems.push('the signature has no time-stamp token');
    const at = token !== null ? timestampInfo(token).genTime : null;
    timestampTime = at?.toISOString() ?? null;
    const r = await verifyCms(sd, bytes, trusted, at, []);
    if (!r.signature || !r.chain) problems.push(`signature: ${r.reason}`);
    if (token !== null) {
      const value = new Uint8Array(sd.signerInfos[0]!.signature.valueBlock.valueHexView);
      const t = await verifyCms(signedDataOf(token), value, trusted, at, certsOf(sd));
      if (!(t.signature && t.chain && equal(timestampInfo(token).imprint, sha256(value))))
        problems.push(`time-stamp: ${t.reason || 'the imprint is not the signature value'}`);
    }
  } catch (e) {
    problems.push(`unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: problems.length === 0 && record !== null, record, timestampTime, problems };
}

export interface BatchAnchorReport {
  readonly ok: boolean;
  /** The record as the file gives it, parsed; null when it is not a batch record. */
  readonly record: {
    readonly tenant: string;
    readonly from: string | null;
    readonly to: string;
    readonly root: string;
    readonly leaves: number;
    readonly previous: string | null;
  } | null;
  /** `genTime` of the signature's time-stamp token: the batch existed no later than this. */
  readonly timestampTime: string | null;
  /** The signer's subject, for the reader; not an identity check. */
  readonly signer: string | null;
  readonly problems: readonly string[];
}

/**
 * The signed, time-stamped record of an hourly batch of chain heads (HIS-036; ADR 0409) as a
 * relying party checks it: the record's hash, the detached signature over it, the chain to a
 * trusted root at the time of the time-stamp, and the RFC 3161 token over the signature value (its
 * own signature and chain, and its imprint). Whether a head is under the record's root, and whether
 * that head is the head of a log, are the caller's two further checks (`headCovered` and
 * `verifyBundle` of `@docedit/history`).
 */
export async function verifyBatchAnchorFile(
  file: { record: string; recordSha256: string; cms: string },
  roots: readonly Uint8Array[],
): Promise<BatchAnchorReport> {
  const problems: string[] = [];
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof file.record !== 'string' ||
    typeof file.recordSha256 !== 'string' ||
    typeof file.cms !== 'string'
  )
    return {
      ok: false,
      record: null,
      timestampTime: null,
      signer: null,
      problems: ['the file has no record, record hash and signature'],
    };
  const bytes = new TextEncoder().encode(file.record);
  if (Buffer.from(sha256(bytes)).toString('hex') !== file.recordSha256)
    problems.push('the record does not hash to the stated SHA-256');
  let record: BatchAnchorReport['record'] = null;
  try {
    const r = JSON.parse(file.record) as Record<string, unknown>;
    const nullable = (v: unknown): boolean => v === null || typeof v === 'string';
    if (
      r['format'] === 'docedit-anchor/1' &&
      typeof r['tenant'] === 'string' &&
      nullable(r['from']) &&
      typeof r['to'] === 'string' &&
      typeof r['root'] === 'string' &&
      typeof r['leaves'] === 'number' &&
      nullable(r['previous'])
    )
      record = {
        tenant: r['tenant'],
        from: r['from'] as string | null,
        to: r['to'],
        root: r['root'],
        leaves: r['leaves'],
        previous: r['previous'] as string | null,
      };
    else problems.push('the record is not of the batch anchor format');
  } catch {
    problems.push('the record is not JSON');
  }
  let timestampTime: string | null = null;
  let signer: string | null = null;
  try {
    const trusted = roots.map(certificateOf);
    const cms = new Uint8Array(Buffer.from(file.cms, 'base64'));
    const sd = signedDataOf(cms);
    signer =
      certsOf(sd)[0]
        ?.subject.typesAndValues.map((t) => String(t.value.valueBlock.value))
        .join(', ') ?? null;
    const token = cmsSignatureToken(cms);
    if (token === null) problems.push('the signature has no time-stamp token');
    const at = token !== null ? timestampInfo(token).genTime : null;
    timestampTime = at?.toISOString() ?? null;
    const r = await verifyCms(sd, bytes, trusted, at, []);
    if (!r.signature || !r.chain) problems.push(`signature: ${r.reason}`);
    if (token !== null) {
      const value = new Uint8Array(sd.signerInfos[0]!.signature.valueBlock.valueHexView);
      const t = await verifyCms(signedDataOf(token), value, trusted, at, certsOf(sd));
      if (!(t.signature && t.chain && equal(timestampInfo(token).imprint, sha256(value))))
        problems.push(`time-stamp: ${t.reason || 'the imprint is not the signature value'}`);
    }
  } catch (e) {
    problems.push(`unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    ok: problems.length === 0 && record !== null,
    record,
    timestampTime,
    signer,
    problems,
  };
}
