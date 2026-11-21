/**
 * A small PDF reader and incremental-update writer for sealing (spike S8, SPK-021).
 *
 * It reads what a sealing step needs: the cross-reference chain (tables and streams), plain
 * objects and objects inside Flate object streams, and it appends an update (new and replaced
 * objects, a new cross-reference section) after the existing bytes. It never changes a byte of the
 * file it was given, which is what keeps an earlier signature valid (12 §8.2 step 5).
 *
 * It is not a general PDF library. Not handled: encryption, hybrid-reference files (`/XRefStm`),
 * linearised files whose first-page section differs from the last (the last section still wins),
 * and repair of damaged files. A file that uses any of these is refused with a `PdfError`.
 */
import { inflateSync } from 'node:zlib';

export class PdfError extends Error {}

/** A name, number, string, boolean or null, kept as the text it had in the file. */
export class Raw {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export class Ref {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen = 0) {
    this.num = num;
    this.gen = gen;
  }
}

/** Keys are names without the leading slash, as written in the file. */
export class Dict extends Map<string, V> {}
export type V = Raw | Ref | V[] | Dict;

export const name = (n: string): Raw => new Raw(`/${n}`);
export const int = (n: number): Raw => new Raw(String(n));
export const str = (s: string): Raw => new Raw(`(${s.replace(/[\\()]/g, '\\$&')})`);

export function dict(entries: Record<string, V>): Dict {
  return new Dict(Object.entries(entries));
}

export function serialise(v: V): string {
  if (v instanceof Raw) return v.text;
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (Array.isArray(v)) return `[${v.map(serialise).join(' ')}]`;
  const parts: string[] = [];
  for (const [k, x] of v) parts.push(`/${k} ${serialise(x)}`);
  return `<<${parts.join(' ')}>>`;
}

const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

function skipWs(s: string, p: number): number {
  for (;;) {
    while (p < s.length && WS.test(s.charAt(p))) p++;
    if (s.charAt(p) === '%') {
      while (p < s.length && s.charAt(p) !== '\n' && s.charAt(p) !== '\r') p++;
    } else return p;
  }
}

function readToken(s: string, p: number): { text: string; end: number } {
  let e = p;
  while (e < s.length && !WS.test(s.charAt(e)) && !DELIM.test(s.charAt(e))) e++;
  return { text: s.slice(p, e), end: e };
}

export function parseValue(s: string, from: number): { v: V; end: number } {
  let p = skipWs(s, from);
  const c = s.charAt(p);
  if (s.startsWith('<<', p)) {
    const d = new Dict();
    p = skipWs(s, p + 2);
    while (!s.startsWith('>>', p)) {
      if (s.charAt(p) !== '/') throw new PdfError(`dictionary key expected at ${p}`);
      const key = readToken(s, p + 1);
      const val = parseValue(s, key.end);
      d.set(key.text, val.v);
      p = skipWs(s, val.end);
      if (p >= s.length) throw new PdfError('unterminated dictionary');
    }
    return { v: d, end: p + 2 };
  }
  if (c === '[') {
    const a: V[] = [];
    p = skipWs(s, p + 1);
    while (s.charAt(p) !== ']') {
      const val = parseValue(s, p);
      a.push(val.v);
      p = skipWs(s, val.end);
      if (p >= s.length) throw new PdfError('unterminated array');
    }
    return { v: a, end: p + 1 };
  }
  if (c === '(') {
    let depth = 0;
    let e = p;
    for (; e < s.length; e++) {
      const ch = s.charAt(e);
      if (ch === '\\') e++;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    return { v: new Raw(s.slice(p, e + 1)), end: e + 1 };
  }
  if (c === '<') {
    const e = s.indexOf('>', p);
    return { v: new Raw(s.slice(p, e + 1)), end: e + 1 };
  }
  if (c === '/') {
    const t = readToken(s, p + 1);
    return { v: new Raw(`/${t.text}`), end: t.end };
  }
  const ref = /^(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+R(?![A-Za-z0-9])/.exec(s.slice(p, p + 40));
  if (ref) return { v: new Ref(Number(ref[1]), Number(ref[2])), end: p + ref[0].length };
  const t = readToken(s, p);
  if (t.text === '') throw new PdfError(`unexpected character at ${p}`);
  return { v: new Raw(t.text), end: t.end };
}

export function asNumber(v: V | undefined): number {
  if (v instanceof Raw && /^[+-]?\d+(\.\d+)?$/.test(v.text)) return Number(v.text);
  throw new PdfError('a number was expected');
}

export function asName(v: V | undefined): string {
  if (v instanceof Raw && v.text.startsWith('/')) return v.text.slice(1);
  throw new PdfError('a name was expected');
}

type XrefEntry = { type: 1; offset: number } | { type: 2; stream: number; index: number };

export interface Trailer {
  size: number;
  root: Ref;
  info: V | undefined;
  id: V | undefined;
  prev: number | undefined;
}

export class PdfDocument {
  readonly bytes: Uint8Array;
  /** The file as a string with one character per byte. */
  readonly text: string;
  readonly version: string;
  readonly xref = new Map<number, XrefEntry>();
  /** The newest cross-reference section's trailer data. */
  trailer!: Trailer;
  /** `stream` when the newest section is a cross-reference stream, else `table`. */
  kind!: 'stream' | 'table';
  /** Offset of the newest cross-reference section (the file's last `startxref`). */
  startxref!: number;
  private readonly objstms = new Map<number, Map<number, V>>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    const h = /^%PDF-(\d\.\d)/.exec(this.text.slice(0, 1024));
    if (!h) throw new PdfError('not a PDF file');
    this.version = h[1] as string;
    this.readXrefChain();
  }

  private readXrefChain(): void {
    const tail = this.text.slice(Math.max(0, this.text.length - 2048));
    const m = [...tail.matchAll(/startxref[\0\t\n\f\r ]+(\d+)/g)].pop();
    if (!m) throw new PdfError('no startxref');
    this.startxref = Number(m[1]);
    let at: number | undefined = this.startxref;
    let first = true;
    const seen = new Set<number>();
    while (at !== undefined) {
      if (seen.has(at)) throw new PdfError('cross-reference loop');
      seen.add(at);
      const section = this.readXrefSection(at);
      if (first) {
        this.kind = section.kind;
        this.trailer = section.trailer;
        first = false;
      }
      at = section.trailer.prev;
    }
  }

  private readXrefSection(at: number): { kind: 'stream' | 'table'; trailer: Trailer } {
    const s = this.text;
    let p = skipWs(s, at);
    if (s.startsWith('xref', p)) {
      p = skipWs(s, p + 4);
      while (!s.startsWith('trailer', p)) {
        const head = /^(\d+)[ \t]+(\d+)/.exec(s.slice(p, p + 40));
        if (!head) throw new PdfError('bad cross-reference subsection');
        let num = Number(head[1]);
        const count = Number(head[2]);
        p = skipWs(s, p + head[0].length);
        for (let i = 0; i < count; i++, num++) {
          const e = /^(\d{10}) (\d{5}) ([nf])/.exec(s.slice(p, p + 20));
          if (!e) throw new PdfError('bad cross-reference entry');
          if (e[3] === 'n' && !this.xref.has(num))
            this.xref.set(num, { type: 1, offset: Number(e[1]) });
          p = skipWs(s, p + 18);
        }
      }
      const t = parseValue(s, p + 7).v;
      if (!(t instanceof Dict)) throw new PdfError('bad trailer');
      if (t.has('XRefStm')) throw new PdfError('hybrid-reference files are not handled');
      if (t.has('Encrypt')) throw new PdfError('encrypted files are not handled');
      return { kind: 'table', trailer: trailerOf(t) };
    }
    const obj = this.parseObjectAt(at);
    if (!(obj.dict instanceof Dict) || asName(obj.dict.get('Type')) !== 'XRef')
      throw new PdfError(`no cross-reference at ${at}`);
    const d = obj.dict;
    if (d.has('Encrypt')) throw new PdfError('encrypted files are not handled');
    const data = this.streamData(obj);
    const w = (d.get('W') as V[]).map(asNumber);
    const size = asNumber(d.get('Size'));
    const index = d.has('Index') ? (d.get('Index') as V[]).map(asNumber) : [0, size];
    const [w0 = 0, w1 = 0, w2 = 0] = w;
    const rec = w0 + w1 + w2;
    let q = 0;
    const field = (width: number, dflt: number): number => {
      if (width === 0) return dflt;
      let n = 0;
      for (let i = 0; i < width; i++) n = n * 256 + (data[q++] ?? 0);
      return n;
    };
    for (let i = 0; i + 1 < index.length; i += 2) {
      let num = index[i] as number;
      const count = index[i + 1] as number;
      for (let k = 0; k < count; k++, num++) {
        if (q + rec > data.length) throw new PdfError('short cross-reference stream');
        const type = field(w0, 1);
        const f2 = field(w1, 0);
        const f3 = field(w2, 0);
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 1, offset: f2 });
        else if (type === 2) this.xref.set(num, { type: 2, stream: f2, index: f3 });
      }
    }
    return { kind: 'stream', trailer: trailerOf(d) };
  }

  /** Parses `n g obj ... endobj` at a byte offset. */
  parseObjectAt(offset: number): { num: number; dict: V; streamStart: number | undefined } {
    const s = this.text;
    const head = /^(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj/.exec(s.slice(offset, offset + 40));
    if (!head) throw new PdfError(`no object at ${offset}`);
    const val = parseValue(s, offset + head[0].length);
    let p = skipWs(s, val.end);
    let streamStart: number | undefined;
    if (s.startsWith('stream', p)) {
      p += 6;
      if (s.charAt(p) === '\r') p++;
      if (s.charAt(p) === '\n') p++;
      streamStart = p;
    }
    return { num: Number(head[1]), dict: val.v, streamStart };
  }

  private streamData(obj: { dict: V; streamStart: number | undefined }): Uint8Array {
    if (!(obj.dict instanceof Dict) || obj.streamStart === undefined)
      throw new PdfError('not a stream');
    let len = obj.dict.get('Length');
    if (len instanceof Ref) len = this.getObject(len.num);
    const n = asNumber(len);
    let data: Uint8Array = this.bytes.subarray(obj.streamStart, obj.streamStart + n);
    const f = obj.dict.get('Filter');
    const filters = f === undefined ? [] : Array.isArray(f) ? f : [f];
    const parmsRaw = obj.dict.get('DecodeParms');
    const parms = parmsRaw === undefined ? [] : Array.isArray(parmsRaw) ? parmsRaw : [parmsRaw];
    filters.forEach((flt, i) => {
      if (asName(flt) !== 'FlateDecode') throw new PdfError(`filter ${asName(flt)} is not handled`);
      data = inflateSync(data);
      const pr = parms[i];
      if (pr instanceof Dict && pr.has('Predictor') && asNumber(pr.get('Predictor')) >= 10)
        data = pngUnpredict(data, pr.has('Columns') ? asNumber(pr.get('Columns')) : 1);
    });
    return data;
  }

  /** The value of an object (the dictionary, for a stream), or undefined when it is not in use. */
  getObject(num: number): V | undefined {
    const e = this.xref.get(num);
    if (!e) return undefined;
    if (e.type === 1) return this.parseObjectAt(e.offset).dict;
    let objs = this.objstms.get(e.stream);
    if (!objs) {
      const st = this.xref.get(e.stream);
      if (!st || st.type !== 1) throw new PdfError('object stream not found');
      const obj = this.parseObjectAt(st.offset);
      const d = obj.dict as Dict;
      const data = Buffer.from(this.streamData(obj)).toString('latin1');
      const count = asNumber(d.get('N'));
      const first = asNumber(d.get('First'));
      const pairs: number[] = [];
      let q = 0;
      for (let i = 0; i < count * 2; i++) {
        q = skipWs(data, q);
        const t = readToken(data, q);
        pairs.push(Number(t.text));
        q = t.end;
      }
      objs = new Map();
      for (let i = 0; i < count; i++)
        objs.set(pairs[i * 2] as number, parseValue(data, first + (pairs[i * 2 + 1] as number)).v);
      this.objstms.set(e.stream, objs);
    }
    return objs.get(num);
  }

  dictOf(v: V | undefined): Dict {
    const r = v instanceof Ref ? this.getObject(v.num) : v;
    if (!(r instanceof Dict)) throw new PdfError('a dictionary was expected');
    return r;
  }

  catalog(): { ref: Ref; dict: Dict } {
    return { ref: this.trailer.root, dict: this.dictOf(this.trailer.root) };
  }

  /** The first page's reference and dictionary, found by walking `/Kids` depth first. */
  firstPage(): { ref: Ref; dict: Dict } {
    const walk = (ref: Ref): { ref: Ref; dict: Dict } | undefined => {
      const d = this.dictOf(ref);
      const kids = d.get('Kids');
      if (!Array.isArray(kids)) return { ref, dict: d };
      for (const k of kids) {
        if (!(k instanceof Ref)) continue;
        const r = walk(k);
        if (r) return r;
      }
      return undefined;
    };
    const pages = this.catalog().dict.get('Pages');
    if (!(pages instanceof Ref)) throw new PdfError('no page tree');
    const p = walk(pages);
    if (!p) throw new PdfError('no pages');
    return p;
  }

  /**
   * Every page in order, with its `/MediaBox` (inherited from the page tree when the page has none)
   * as `[x0, y0, x1, y1]` in points. A page with no box gets null.
   */
  pageList(): Array<{
    ref: Ref;
    dict: Dict;
    mediaBox: [number, number, number, number] | null;
  }> {
    const out: Array<{
      ref: Ref;
      dict: Dict;
      mediaBox: [number, number, number, number] | null;
    }> = [];
    const box = (v: V | undefined): [number, number, number, number] | null => {
      const arr = v instanceof Ref ? this.getObject(v.num) : v;
      if (!Array.isArray(arr) || arr.length !== 4) return null;
      const n = arr.map((x) => asNumber(x instanceof Ref ? (this.getObject(x.num) as V) : x));
      return [n[0] as number, n[1] as number, n[2] as number, n[3] as number];
    };
    const walk = (ref: Ref, inherited: [number, number, number, number] | null, depth: number) => {
      if (depth > 64) throw new PdfError('the page tree is too deep');
      const d = this.dictOf(ref);
      const own = box(d.get('MediaBox')) ?? inherited;
      const kids = d.get('Kids');
      if (!Array.isArray(kids)) {
        out.push({ ref, dict: d, mediaBox: own });
        return;
      }
      for (const k of kids) if (k instanceof Ref) walk(k, own, depth + 1);
    };
    const pages = this.catalog().dict.get('Pages');
    if (!(pages instanceof Ref)) throw new PdfError('no page tree');
    walk(pages, null, 0);
    return out;
  }
}

function trailerOf(d: Dict): Trailer {
  const root = d.get('Root');
  if (!(root instanceof Ref)) throw new PdfError('no Root in the trailer');
  const prev = d.get('Prev');
  return {
    size: asNumber(d.get('Size')),
    root,
    info: d.get('Info'),
    id: d.get('ID'),
    prev: prev === undefined ? undefined : asNumber(prev),
  };
}

function pngUnpredict(data: Uint8Array, columns: number): Uint8Array {
  const row = columns + 1;
  const rows = Math.floor(data.length / row);
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * row] as number;
    for (let c = 0; c < columns; c++) {
      const x = data[r * row + 1 + c] as number;
      const a = c > 0 ? (out[r * columns + c - 1] as number) : 0;
      const b = r > 0 ? (out[(r - 1) * columns + c] as number) : 0;
      const cc = c > 0 && r > 0 ? (out[(r - 1) * columns + c - 1] as number) : 0;
      let v: number;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) {
        const pp = a + b - cc;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - cc);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
      } else throw new PdfError(`PNG predictor ${ft} is not handled`);
      out[r * columns + c] = v & 0xff;
    }
  }
  return out;
}

/** One object of an update: a dictionary or array value, optionally with stream bytes. */
export interface NewObject {
  num: number;
  value: V | string;
  stream?: Uint8Array;
}

export interface UpdateResult {
  /** The whole file: the original bytes and the update. */
  bytes: Uint8Array;
  /** Where each object of the update starts in `bytes`. */
  offsets: Map<number, number>;
  /** Where the cross-reference section of the update starts. */
  xrefOffset: number;
}

/**
 * Appends an incremental update to `doc`: the given objects (new or replacing), then a
 * cross-reference section of the same kind as the file's newest one, and `startxref`. The original
 * bytes are copied unchanged. Object numbers of new objects come from `doc.trailer.size` upward;
 * use `nextNumbers`.
 */
export function appendUpdate(doc: PdfDocument, objects: readonly NewObject[]): UpdateResult {
  const enc = (t: string): Buffer => Buffer.from(t, 'latin1');
  const pieces: Buffer[] = [];
  let pos = doc.bytes.length;
  const push = (b: Buffer): void => {
    pieces.push(b);
    pos += b.length;
  };
  // PDF 2.0 asks for an end-of-line before the update; the file normally ends with one already.
  push(enc('\n'));
  const offsets = new Map<number, number>();
  for (const o of objects) {
    offsets.set(o.num, pos);
    const body = typeof o.value === 'string' ? o.value : serialise(o.value);
    if (o.stream) {
      push(enc(`${o.num} 0 obj\n${body}\nstream\n`));
      push(Buffer.from(o.stream));
      push(enc('\nendstream\nendobj\n'));
    } else push(enc(`${o.num} 0 obj\n${body}\nendobj\n`));
  }
  const maxNum = Math.max(doc.trailer.size - 1, ...objects.map((o) => o.num));
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  const xrefOffset = pos;
  const trailerEntries = (size: number): string => {
    const t = new Dict();
    t.set('Size', int(size));
    t.set('Root', doc.trailer.root);
    if (doc.trailer.info !== undefined) t.set('Info', doc.trailer.info);
    if (doc.trailer.id !== undefined) t.set('ID', doc.trailer.id);
    t.set('Prev', int(doc.startxref));
    return [...t].map(([k, x]) => `/${k} ${serialise(x)}`).join(' ');
  };
  if (doc.kind === 'table') {
    const lines: string[] = ['xref\n'];
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && (nums[j + 1] as number) === (nums[j] as number) + 1) j++;
      lines.push(`${nums[i]} ${j - i + 1}\n`);
      for (let k = i; k <= j; k++)
        lines.push(`${String(offsets.get(nums[k] as number)).padStart(10, '0')} 00000 n \n`);
      i = j + 1;
    }
    lines.push(`trailer\n<<${trailerEntries(maxNum + 1)}>>\n`);
    push(enc(lines.join('')));
  } else {
    const xnum = maxNum + 1;
    nums.push(xnum);
    offsets.set(xnum, xrefOffset);
    const rows: number[] = [];
    const index: number[] = [];
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && (nums[j + 1] as number) === (nums[j] as number) + 1) j++;
      index.push(nums[i] as number, j - i + 1);
      for (let k = i; k <= j; k++) {
        const off = offsets.get(nums[k] as number) as number;
        rows.push(1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, 0, 0);
      }
      i = j + 1;
    }
    const data = Buffer.from(rows);
    const head =
      `<</Type /XRef /W [1 4 2] /Index [${index.join(' ')}] /Length ${data.length} ` +
      `${trailerEntries(xnum + 1)}>>`;
    push(enc(`${xnum} 0 obj\n${head}\nstream\n`));
    push(data);
    push(enc('\nendstream\nendobj\n'));
  }
  push(enc(`startxref\n${xrefOffset}\n%%EOF\n`));
  const out = new Uint8Array(pos);
  out.set(doc.bytes, 0);
  let q = doc.bytes.length;
  for (const b of pieces) {
    out.set(b, q);
    q += b.length;
  }
  return { bytes: out, offsets, xrefOffset };
}

/** `count` new object numbers after the file's current ones. */
export function nextNumbers(doc: PdfDocument, count: number): number[] {
  return Array.from({ length: count }, (_, i) => doc.trailer.size + i);
}
