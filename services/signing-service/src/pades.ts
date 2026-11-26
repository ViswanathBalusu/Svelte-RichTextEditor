/**
 * Seals a PDF with a PAdES signature (ETSI EN 319 142-1) whose key is in a key service, with an
 * RFC 3161 signature time-stamp, and optionally the long-term validation data (B-LT) and a
 * document time-stamp (B-LTA). Spike S8 (SPK-021).
 *
 * Every step appends an incremental update. The bytes of the PDF that came in are never changed,
 * so the signature of one step stays valid under the updates of the next (12 §8.2 step 5).
 */
import { createHash } from 'node:crypto';
import { buildCms, timestampInfo, type TimestampInfo, type TimestampSource } from './cms.ts';
import type { KeyService } from './keyservice.ts';
import {
  appendUpdate,
  Dict,
  dict,
  int,
  name,
  nextNumbers,
  PdfDocument,
  PdfError,
  Raw,
  Ref,
  str,
  type NewObject,
  type V,
} from './pdf.ts';

export type PadesProfile = 'B-T' | 'B-LT' | 'B-LTA';

/** Revocation data and certificates that a validator needs offline (the DSS of a B-LT file). */
export interface ValidationData {
  certificates: Uint8Array[];
  crls: Uint8Array[];
  ocsps: Uint8Array[];
}

export interface SealOptions {
  keyService: KeyService;
  /** The signing certificate (DER) first, then its issuers up to but not including the root. */
  chain: readonly Uint8Array[];
  timestamps: TimestampSource;
  profile: PadesProfile;
  /**
   * Validation data for B-LT and B-LTA, collected at sealing time (SR-K8). It is called after the
   * signature and its time-stamp exist, so that it can include the time-stamp's own chain, which
   * is passed in (DER certificates).
   */
  validationData?: (timestampCertificates: readonly Uint8Array[]) => ValidationData;
  /** The signing time recorded in `/M` (default now). */
  signingTime?: Date;
  fieldName?: string;
  reason?: string;
  location?: string;
  /** Room for the CMS in `/Contents`, in bytes. */
  contentsBytes?: number;
  /**
   * Visible appearances to draw before the signature is made, so that the signature covers them
   * (FRW-057). Appended after the input: the bytes that came in stay the first bytes.
   */
  appearances?: readonly AppearanceItem[];
}

const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

function pdfDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Room for the CMS in /Contents by default. The signature of the spike's sample needed 6,575 bytes
 * with a time-stamp token that carries the authority's chain (the test authority; RSA 3,072-bit key for the seal).
 */
const DEFAULT_ROOM = 16_384;

const zeros = (): Raw => new Raw('0000000000');

function copyDict(d: Dict): Dict {
  return new Dict(d);
}

interface Field {
  bytes: Uint8Array;
  /** Offset of the `<` of `/Contents` and one past its `>`. */
  contentsStart: number;
  contentsEnd: number;
  sigNum: number;
}

/**
 * Appends the signature field, its signature dictionary with a zeroed `/Contents` and `/ByteRange`
 * of fixed width, and the changes the field needs in the catalog, the first page and the form.
 * `/Type /Sig` for a signature, `/Type /DocTimeStamp` for a document time-stamp.
 */
function appendField(
  doc: PdfDocument,
  spec: {
    type: 'Sig' | 'DocTimeStamp';
    subFilter: string;
    fieldName: string;
    time: Date;
    contentsBytes: number;
    reason?: string | undefined;
    location?: string | undefined;
  },
): Field {
  const [sigNum, fieldNum, newAcroNum] = nextNumbers(doc, 3) as [number, number, number];
  const objects: NewObject[] = [];
  const cat = doc.catalog();
  const page = doc.firstPage();

  const sig = dict({
    Type: name(spec.type),
    Filter: name('Adobe.PPKLite'),
    SubFilter: name(spec.subFilter),
    ByteRange: [zeros(), zeros(), zeros(), zeros()],
    Contents: new Raw(`<${'0'.repeat(spec.contentsBytes * 2)}>`),
    M: str(pdfDate(spec.time)),
  });
  if (spec.reason) sig.set('Reason', str(spec.reason));
  if (spec.location) sig.set('Location', str(spec.location));
  objects.push({ num: sigNum, value: sig });

  // An invisible widget: no appearance, a zero rectangle, "print" and "locked" flags.
  objects.push({
    num: fieldNum,
    value: dict({
      Type: name('Annot'),
      Subtype: name('Widget'),
      FT: name('Sig'),
      T: str(spec.fieldName),
      V: new Ref(sigNum),
      F: int(132),
      Rect: [int(0), int(0), int(0), int(0)],
      P: page.ref,
    }),
  });
  const fieldRef = new Ref(fieldNum);

  // Page: one more annotation.
  const pageDict = copyDict(page.dict);
  const annots = pageDict.get('Annots');
  if (annots instanceof Ref) {
    const arr = doc.getObject(annots.num);
    if (!Array.isArray(arr)) throw new PdfError('/Annots is not an array');
    objects.push({ num: annots.num, value: [...arr, fieldRef] });
  } else {
    pageDict.set('Annots', [...(Array.isArray(annots) ? annots : []), fieldRef]);
  }
  objects.push({ num: page.ref.num, value: pageDict });

  // Form: the field goes in `/Fields`, and `/SigFlags` says the file has signatures and is
  // append-only (1 | 2).
  const catDict = copyDict(cat.dict);
  const acro = catDict.get('AcroForm');
  const acroDict = acro === undefined ? new Dict() : copyDict(doc.dictOf(acro));
  const fields = acroDict.get('Fields');
  if (fields instanceof Ref) {
    const arr = doc.getObject(fields.num);
    if (!Array.isArray(arr)) throw new PdfError('/Fields is not an array');
    objects.push({ num: fields.num, value: [...arr, fieldRef] });
  } else {
    acroDict.set('Fields', [...(Array.isArray(fields) ? fields : []), fieldRef]);
  }
  acroDict.set('SigFlags', int(3));
  if (acro instanceof Ref) objects.push({ num: acro.num, value: acroDict });
  else {
    objects.push({ num: newAcroNum, value: acroDict });
    catDict.set('AcroForm', new Ref(newAcroNum));
  }
  objects.push({ num: cat.ref.num, value: catDict });

  const upd = appendUpdate(doc, objects);
  const text = Buffer.from(upd.bytes).toString('latin1');
  const at = text.indexOf('/Contents <', doc.bytes.length);
  if (at < 0) throw new PdfError('placeholder not found');
  const contentsStart = at + '/Contents '.length;
  const contentsEnd = contentsStart + 2 * spec.contentsBytes + 2;
  return { bytes: upd.bytes, contentsStart, contentsEnd, sigNum };
}

/** Writes the final `/ByteRange` into the placeholder and returns the bytes to be signed. */
function fixByteRange(f: Field, base: number): { pdf: Uint8Array; signed: Uint8Array } {
  const total = f.bytes.length;
  const range = [0, f.contentsStart, f.contentsEnd, total - f.contentsEnd];
  const text = Buffer.from(f.bytes).toString('latin1');
  const at = text.indexOf('/ByteRange [', base);
  if (at < 0) throw new PdfError('byte range placeholder not found');
  const filled = `/ByteRange [${range.map((n) => String(n).padStart(10, '0')).join(' ')}]`;
  const old = text.slice(at, at + filled.length);
  if (!/^\/ByteRange \[0{10} 0{10} 0{10} 0{10}\]$/.test(old))
    throw new PdfError('byte range placeholder has the wrong shape');
  const pdf = new Uint8Array(f.bytes);
  pdf.set(Buffer.from(filled, 'latin1'), at);
  const signed = new Uint8Array(f.contentsStart + (total - f.contentsEnd));
  signed.set(pdf.subarray(0, f.contentsStart), 0);
  signed.set(pdf.subarray(f.contentsEnd), f.contentsStart);
  return { pdf, signed };
}

function putContents(pdf: Uint8Array, f: Field, cms: Uint8Array, room: number): Uint8Array {
  if (cms.length > room)
    throw new PdfError(`the signature (${cms.length} bytes) does not fit its ${room} bytes`);
  const out = new Uint8Array(pdf);
  out.set(Buffer.from(Buffer.from(cms).toString('hex'), 'latin1'), f.contentsStart + 1);
  return out;
}

/** The `/Contents` bytes (DER, padding removed) of the signature whose dictionary is `num`. */
export function signatureContents(pdf: Uint8Array, contentsStart: number): Uint8Array {
  const text = Buffer.from(pdf).toString('latin1');
  const end = text.indexOf('>', contentsStart);
  const hex = text.slice(contentsStart + 1, end);
  const all = Buffer.from(hex, 'hex');
  // DER: a sequence tag, then the length. Everything after that length is padding.
  const lenByte = all[1] as number;
  let len: number;
  let head: number;
  if (lenByte < 0x80) {
    len = lenByte;
    head = 2;
  } else {
    const n = lenByte & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (all[2 + i] as number);
    head = 2 + n;
  }
  return new Uint8Array(all.subarray(0, head + len));
}

/** Adds the DSS: certificates, CRLs and OCSP responses, and a VRI entry for each signature. */
function appendDss(
  doc: PdfDocument,
  vd: ValidationData,
  signatures: readonly Uint8Array[],
  time: Date,
): Uint8Array {
  const all = [...vd.certificates, ...vd.crls, ...vd.ocsps];
  const nums = nextNumbers(doc, all.length + 1);
  const dssNum = nums[all.length] as number;
  const objects: NewObject[] = [];
  const refs = (list: Uint8Array[], offset: number): V[] =>
    list.map((_, i) => new Ref(nums[offset + i] as number));
  all.forEach((bytes, i) =>
    objects.push({
      num: nums[i] as number,
      value: dict({ Length: int(bytes.length) }),
      stream: bytes,
    }),
  );
  const certRefs = refs(vd.certificates, 0);
  const crlRefs = refs(vd.crls, vd.certificates.length);
  const ocspRefs = refs(vd.ocsps, vd.certificates.length + vd.crls.length);
  const vri = new Dict();
  for (const s of signatures) {
    const key = createHash('sha1').update(s).digest('hex').toUpperCase();
    vri.set(key, dict({ Cert: certRefs, CRL: crlRefs, OCSP: ocspRefs, TU: str(pdfDate(time)) }));
  }
  const dss = dict({
    Type: name('DSS'),
    Certs: certRefs,
    CRLs: crlRefs,
    OCSPs: ocspRefs,
    VRI: vri,
  });
  if (!ocspRefs.length) dss.delete('OCSPs');
  if (!crlRefs.length) dss.delete('CRLs');
  objects.push({ num: dssNum, value: dss });
  const cat = doc.catalog();
  const catDict = copyDict(cat.dict);
  catDict.set('DSS', new Ref(dssNum));
  if (Number(doc.version) < 2) {
    // PDF 1.x needs the ISO 32000 extension that defines the DSS and the document time-stamp.
    catDict.set(
      'Extensions',
      dict({
        ESIC: dict({ BaseVersion: name('1.7'), ExtensionLevel: int(1) }),
      }),
    );
  }
  objects.push({ num: cat.ref.num, value: catDict });
  return appendUpdate(doc, objects).bytes;
}

/** One visible appearance: a rectangle on a page, in points from the lower-left corner of the page's box. */
export interface AppearanceItem {
  /** 1-based page number. */
  readonly page: number;
  /** `[x0, y0, x1, y1]` in PDF user space. */
  readonly rect: readonly [number, number, number, number];
  /** The lines of text; characters outside Latin-1 are drawn as `?` (a standard font is used). */
  readonly lines: readonly string[];
  /** The annotation's name and `/Contents`, for readers that list annotations. */
  readonly label: string;
}

/** Text as a PDF string in the standard encoding: Latin-1 only, escaped. */
function pdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    const safe = c >= 0x20 && c <= 0x7e ? ch : c >= 0xa0 && c <= 0xff ? ch : '?';
    out += safe === '(' || safe === ')' || safe === '\\' ? `\\${safe}` : safe;
  }
  return out;
}

/**
 * Appends the visible appearances as stamp annotations with their own appearance streams (a
 * border and the lines of text in Helvetica), in one incremental update. They are print-only,
 * read-only and locked. The page tree is read for the page of each item; an item whose page does
 * not exist is refused. The bytes that came in are the first bytes that come out.
 */
export function appendAppearances(
  pdf: Uint8Array,
  items: readonly AppearanceItem[],
  time: Date = new Date(),
): Uint8Array {
  const doc = new PdfDocument(pdf);
  const pages = doc.pageList();
  const nums = nextNumbers(doc, items.length * 2 + 1);
  const fontNum = nums[nums.length - 1] as number;
  const objects: NewObject[] = [
    {
      num: fontNum,
      value: dict({
        Type: name('Font'),
        Subtype: name('Type1'),
        BaseFont: name('Helvetica'),
        Encoding: name('WinAnsiEncoding'),
      }),
    },
  ];
  const byPage = new Map<number, Ref[]>();
  items.forEach((item, i) => {
    const page = pages[item.page - 1];
    if (page === undefined)
      throw new PdfError(`the page ${item.page} of an appearance does not exist`);
    const [x0, y0, x1, y1] = item.rect;
    const w = x1 - x0;
    const h = y1 - y0;
    const lines = item.lines.map(pdfText);
    const longest = Math.max(1, ...lines.map((l) => l.length));
    // Helvetica's average advance is about half an em: fit the longest line, then the height.
    const size = Math.max(
      3,
      Math.min(10, (w - 4) / (longest * 0.55), (h - 4) / (Math.max(1, lines.length) * 1.2)),
    );
    const f = (n: number): string => (Math.round(n * 100) / 100).toString();
    const content = [
      'q 0.4 w 0.2 0.2 0.2 RG',
      `0.5 0.5 ${f(w - 1)} ${f(h - 1)} re S`,
      'BT',
      `/F1 ${f(size)} Tf 0.1 0.1 0.1 rg`,
      `${f(size * 1.2)} TL`,
      `3 ${f(h - 2 - size)} Td`,
      ...lines.map((l, k) => `${k === 0 ? '' : 'T* '}(${l}) Tj`),
      'ET Q',
    ].join('\n');
    const apNum = nums[i * 2] as number;
    const annotNum = nums[i * 2 + 1] as number;
    objects.push({
      num: apNum,
      value: dict({
        Type: name('XObject'),
        Subtype: name('Form'),
        BBox: [int(0), int(0), new Raw(f(w)), new Raw(f(h))],
        Resources: dict({ Font: dict({ F1: new Ref(fontNum) }) }),
        Length: int(Buffer.byteLength(content, 'latin1')),
      }),
      stream: new Uint8Array(Buffer.from(content, 'latin1')),
    });
    objects.push({
      num: annotNum,
      value: dict({
        Type: name('Annot'),
        Subtype: name('Stamp'),
        Rect: item.rect.map((n) => new Raw(f(n))),
        F: int(4 | 64 | 128),
        P: page.ref,
        NM: str(item.label),
        Contents: str(item.label),
        M: str(pdfDate(time)),
        AP: dict({ N: new Ref(apNum) }),
      }),
    });
    byPage.set(item.page, [...(byPage.get(item.page) ?? []), new Ref(annotNum)]);
  });
  for (const [pageNo, refs] of byPage) {
    const page = pages[pageNo - 1]!;
    const pageDict = copyDict(page.dict);
    const annots = pageDict.get('Annots');
    if (annots instanceof Ref) {
      const arr = doc.getObject(annots.num);
      if (!Array.isArray(arr)) throw new PdfError('/Annots is not an array');
      objects.push({ num: annots.num, value: [...arr, ...refs] });
    } else {
      pageDict.set('Annots', [...(Array.isArray(annots) ? annots : []), ...refs]);
    }
    objects.push({ num: page.ref.num, value: pageDict });
  }
  return appendUpdate(doc, objects).bytes;
}
export interface SealResult {
  pdf: Uint8Array;
  /** The sizes of the file after each step, for the report. */
  steps: { name: string; length: number }[];
  /** The time of the signature time-stamp (`genTime`). */
  timestampTime: Date;
  /** The size of the signature's CMS in bytes (the room it needs in `/Contents`). */
  cmsBytes: number;
  /**
   * The certificates of the newest time-stamp token (DER), the authority's first: of the document
   * time-stamp for B-LTA, else of the signature time-stamp. Their `notAfter` is when renewal is due.
   */
  tokenCertificates: readonly Uint8Array[];
}

export async function sealPdf(input: Uint8Array, opts: SealOptions): Promise<SealResult> {
  const room = opts.contentsBytes ?? DEFAULT_ROOM;
  const time = opts.signingTime ?? new Date();
  const steps: SealResult['steps'] = [{ name: 'input', length: input.length }];

  // 0. The visible appearances at the field positions, drawn after the compile and before the
  // signature, which then covers them (FRW-057).
  let base = input;
  if (opts.appearances && opts.appearances.length > 0) {
    base = appendAppearances(input, opts.appearances);
    steps.push({ name: 'visible appearances', length: base.length });
  }

  // 1. The signature, with its signature time-stamp (B-T).
  let doc = new PdfDocument(base);
  const f1 = appendField(doc, {
    type: 'Sig',
    subFilter: 'ETSI.CAdES.detached',
    fieldName: opts.fieldName ?? 'Seal1',
    time,
    contentsBytes: room,
    reason: opts.reason,
    location: opts.location,
  });
  const r1 = fixByteRange(f1, base.length);
  const cms = await buildCms({
    keyService: opts.keyService,
    chain: opts.chain,
    contentDigest: sha256(r1.signed),
    timestamps: opts.timestamps,
  });
  let pdf = putContents(r1.pdf, f1, cms, room);
  steps.push({ name: 'signature and signature time-stamp (B-T)', length: pdf.length });
  const tsToken = extractSignatureTimestamp(cms);
  const tsInfo = timestampInfo(tsToken);

  if (opts.profile === 'B-T')
    return {
      pdf,
      steps,
      timestampTime: tsInfo.genTime,
      cmsBytes: cms.length,
      tokenCertificates: tsInfo.certificates,
    };

  // 2. The validation data (B-LT).
  if (!opts.validationData) throw new PdfError('B-LT needs validation data');
  doc = new PdfDocument(pdf);
  pdf = appendDss(
    doc,
    opts.validationData(tsInfo.certificates),
    [signatureContents(pdf, f1.contentsStart)],
    time,
  );
  steps.push({ name: 'validation data (DSS, B-LT)', length: pdf.length });

  if (opts.profile === 'B-LT')
    return {
      pdf,
      steps,
      timestampTime: tsInfo.genTime,
      cmsBytes: cms.length,
      tokenCertificates: tsInfo.certificates,
    };

  // 3. The document time-stamp over everything so far, the DSS included (B-LTA).
  const stamped = await addDocumentTimestamp(pdf, {
    timestamps: opts.timestamps,
    time,
    contentsBytes: room,
  });
  steps.push({ name: 'document time-stamp (B-LTA)', length: stamped.length });
  const newest = lastTimestamp(stamped);
  return {
    pdf: stamped,
    steps,
    timestampTime: tsInfo.genTime,
    cmsBytes: cms.length,
    tokenCertificates: newest?.certificates ?? tsInfo.certificates,
  };
}

/**
 * Appends a document time-stamp (ETSI.RFC3161) over the whole file as it stands. On a B-LT file
 * this makes it B-LTA; on a B-LTA file it renews the time-stamp (12 §8.2 step 5, FRW-056). The
 * bytes that came in are the first bytes of the bytes that come out.
 */
export async function addDocumentTimestamp(
  pdf: Uint8Array,
  opts: { timestamps: TimestampSource; time?: Date; contentsBytes?: number; fieldName?: string },
): Promise<Uint8Array> {
  const room = opts.contentsBytes ?? DEFAULT_ROOM;
  const doc = new PdfDocument(pdf);
  const f = appendField(doc, {
    type: 'DocTimeStamp',
    subFilter: 'ETSI.RFC3161',
    // One field per time-stamp: the first is DocTimeStamp1, a renewal DocTimeStamp2, and so on.
    fieldName:
      opts.fieldName ??
      `DocTimeStamp${
        (
          Buffer.from(pdf)
            .toString('latin1')
            .match(/\/Type \/DocTimeStamp/g) ?? []
        ).length + 1
      }`,
    time: opts.time ?? new Date(),
    contentsBytes: room,
  });
  const r = fixByteRange(f, pdf.length);
  const token = await opts.timestamps.stamp(sha256(r.signed));
  return putContents(r.pdf, f, token, room);
}
/** The contents (DER) and the `/ByteRange` start of every signature and time-stamp of a file. */
function signaturesIn(pdf: Uint8Array): Uint8Array[] {
  const text = Buffer.from(pdf).toString('latin1');
  const out: Uint8Array[] = [];
  for (const m of text.matchAll(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/g))
    out.push(signatureContents(pdf, Number(m[2])));
  return out;
}

export interface ExtendOptions {
  readonly timestamps: TimestampSource;
  /**
   * Fresh validation data, collected now (the certificates of the time-stamp authority are given),
   * to append as a new DSS update. Absent: no DSS update, only the time-stamp.
   */
  readonly validationData?: (timestampCertificates: readonly Uint8Array[]) => ValidationData;
  readonly time?: Date;
  readonly contentsBytes?: number;
}

export interface ExtendResult {
  readonly pdf: Uint8Array;
  readonly steps: { name: string; length: number }[];
  /** `genTime` of the document time-stamp that was appended. */
  readonly timestampTime: Date;
  /** The certificates the new token carries (DER): the authority's, first. */
  readonly tokenCertificates: readonly Uint8Array[];
}

/**
 * Extends a sealed PDF for long-term validation (12 §8.2 step 5; FRW-056): appends, as incremental
 * updates only, fresh validation data (a new DSS naming every signature the file holds) when
 * `validationData` is given, and then a further document time-stamp over the whole file as it
 * stands. The bytes that came in are the first bytes of the bytes that come out, so the original
 * signature still validates. A file with no signature is refused.
 */
export async function extendPdf(input: Uint8Array, opts: ExtendOptions): Promise<ExtendResult> {
  const room = opts.contentsBytes ?? DEFAULT_ROOM;
  const time = opts.time ?? new Date();
  const steps: ExtendResult['steps'] = [{ name: 'input', length: input.length }];
  if (!/\/ByteRange \[/.test(Buffer.from(input).toString('latin1')))
    throw new PdfError('the file holds no signature to extend');
  let pdf = input;
  if (opts.validationData) {
    // The authority's certificates are those of the newest token; a fresh token comes next, so the
    // data is collected for the token of the file as it stands.
    const known = lastTimestamp(input);
    pdf = appendDss(
      new PdfDocument(pdf),
      opts.validationData(known?.certificates ?? []),
      signaturesIn(pdf),
      time,
    );
    steps.push({ name: 'validation data (DSS)', length: pdf.length });
  }
  pdf = await addDocumentTimestamp(pdf, { timestamps: opts.timestamps, time, contentsBytes: room });
  steps.push({ name: 'document time-stamp', length: pdf.length });
  const token = lastTimestamp(pdf);
  if (token === null) throw new PdfError('the appended time-stamp cannot be read back');
  return { pdf, steps, timestampTime: token.genTime, tokenCertificates: token.certificates };
}

/** The newest document time-stamp of a file, read back, or null when it has none. */
function lastTimestamp(pdf: Uint8Array): TimestampInfo | null {
  const text = Buffer.from(pdf).toString('latin1');
  let last: TimestampInfo | null = null;
  for (const m of text.matchAll(/\/Type \/DocTimeStamp/g)) {
    const range = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/.exec(
      text.slice(m.index, m.index + 400),
    );
    if (range) last = timestampInfo(signatureContents(pdf, Number(range[2])));
  }
  return last;
}

/** The signature time-stamp token inside a CMS (DER), as an unsigned attribute. */
function extractSignatureTimestamp(cms: Uint8Array): Uint8Array {
  // Found by its attribute identifier, 1.2.840.113549.1.9.16.2.14, then the SET and the token.
  const oid = Buffer.from('060b2a864886f70d010910020e', 'hex');
  const buf = Buffer.from(cms);
  const at = buf.indexOf(oid);
  if (at < 0) throw new PdfError('no signature time-stamp in the signature');
  let p = at + oid.length;
  if (buf[p] !== 0x31) throw new PdfError('unexpected attribute shape');
  p += 1;
  const lenByte = buf[p] as number;
  p += 1;
  if (lenByte >= 0x80) p += lenByte & 0x7f;
  // The token is the one value of the SET: a sequence.
  const start = p;
  const l2 = buf[p + 1] as number;
  let len: number;
  let head: number;
  if (l2 < 0x80) {
    len = l2;
    head = 2;
  } else {
    const n = l2 & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[p + 2 + i] as number);
    head = 2 + n;
  }
  return new Uint8Array(buf.subarray(start, start + head + len));
}
