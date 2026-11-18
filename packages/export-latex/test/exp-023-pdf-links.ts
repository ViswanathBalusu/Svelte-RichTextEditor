/**
 * A small reader of the link structure of a compiled PDF, for EXP-023 criterion 5 (Node.js only).
 * It reads the indirect objects (object streams included, Flate only), the page tree, each page's
 * link annotations with their rectangles and destinations, the named destinations (the name tree
 * of the catalogue's /Names /Dests, or the catalogue's /Dests dictionary) and the outline, so that
 * a test can say which page each link of a table of contents goes to and whether it is the same
 * destination as a heading's bookmark. It is not a general PDF parser: encryption, LZW and
 * predictors are not handled, and the compiles of the converter's tests use none of them.
 *
 * Work of lane U-EXP-017-032 (fixer, 2026-11-13).
 */
import { inflateSync } from 'node:zlib';

export type PdfValue =
  | number
  | boolean
  | null
  | { kind: 'str'; v: string }
  | { kind: 'name'; v: string }
  | { kind: 'ref'; n: number }
  | { kind: 'dict'; v: Record<string, PdfValue> }
  | PdfValue[];

type Dict = Record<string, PdfValue>;

const WS = /[\0\t\n\f\r ]/;
const DELIM = /[\0\t\n\f\r ()<>[\]{}/%]/;

class Lexer {
  pos: number;
  readonly s: string;
  constructor(s: string, pos = 0) {
    this.s = s;
    this.pos = pos;
  }

  skip(): void {
    for (;;) {
      while (this.pos < this.s.length && WS.test(this.s[this.pos]!)) this.pos++;
      if (this.s[this.pos] !== '%') return;
      while (this.pos < this.s.length && this.s[this.pos] !== '\n' && this.s[this.pos] !== '\r')
        this.pos++;
    }
  }

  peekWord(): string {
    this.skip();
    let e = this.pos;
    while (e < this.s.length && !DELIM.test(this.s[e]!)) e++;
    return this.s.slice(this.pos, e);
  }

  value(): PdfValue {
    this.skip();
    const s = this.s;
    const c = s[this.pos];
    if (c === '<' && s[this.pos + 1] === '<') {
      this.pos += 2;
      const v: Dict = {};
      for (;;) {
        this.skip();
        if (s.startsWith('>>', this.pos)) {
          this.pos += 2;
          return { kind: 'dict', v };
        }
        const k = this.value();
        if (typeof k !== 'object' || k === null || Array.isArray(k) || k.kind !== 'name')
          throw new Error(`a dictionary key is not a name at ${this.pos}`);
        v[k.v] = this.value();
      }
    }
    if (c === '<') {
      const e = s.indexOf('>', this.pos);
      const hex = s.slice(this.pos + 1, e).replace(/\s+/g, '');
      this.pos = e + 1;
      const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
      let out = '';
      for (let i = 0; i < padded.length; i += 2)
        out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
      return { kind: 'str', v: out };
    }
    if (c === '(') return { kind: 'str', v: this.literal() };
    if (c === '[') {
      this.pos++;
      const a: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (s[this.pos] === ']') {
          this.pos++;
          return a;
        }
        a.push(this.value());
      }
    }
    if (c === '/') {
      let e = this.pos + 1;
      while (e < s.length && !DELIM.test(s[e]!)) e++;
      const raw = s.slice(this.pos + 1, e);
      this.pos = e;
      return {
        kind: 'name',
        v: raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
      };
    }
    const word = this.peekWord();
    if (word === '') throw new Error(`unexpected ${JSON.stringify(c)} at ${this.pos}`);
    this.pos += word.length;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    const n = Number(word);
    if (Number.isNaN(n)) throw new Error(`unexpected ${JSON.stringify(word)} at ${this.pos}`);
    // An indirect reference: two integers and R.
    if (Number.isInteger(n)) {
      const save = this.pos;
      const g = this.peekWord();
      if (/^\d+$/.test(g)) {
        this.pos += g.length;
        if (this.peekWord() === 'R') {
          this.pos += 1;
          return { kind: 'ref', n };
        }
      }
      this.pos = save;
    }
    return n;
  }

  literal(): string {
    const s = this.s;
    let depth = 0;
    let out = '';
    this.pos++;
    for (;;) {
      const c = s[this.pos++];
      if (c === undefined) throw new Error('an unterminated string');
      if (c === '\\') {
        const d = s[this.pos++]!;
        const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (map[d] !== undefined) out += map[d];
        else if (/[0-7]/.test(d)) {
          let oct = d;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] ?? '')) oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (d === '\r' || d === '\n') {
          if (d === '\r' && s[this.pos] === '\n') this.pos++;
        } else out += d;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) return out;
        depth--;
      }
      out += c;
    }
  }
}

const isDict = (v: PdfValue | undefined): v is { kind: 'dict'; v: Dict } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'dict';
const isRef = (v: PdfValue | undefined): v is { kind: 'ref'; n: number } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'ref';
const nameOf = (v: PdfValue | undefined): string | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'name' ? v.v : null;
const strOf = (v: PdfValue | undefined): string | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'str' ? v.v : null;

/** A PDF text string as JavaScript text (UTF-16BE with a byte order mark, or PDFDocEncoding read as Latin-1). */
export function textString(bytes: string): string {
  if (bytes.startsWith('\xfe\xff')) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  if (bytes.startsWith('\xef\xbb\xbf'))
    return Buffer.from(bytes.slice(3), 'latin1').toString('utf8');
  return bytes;
}

export interface PdfLink {
  /** The index of the page the annotation is on, from 0. */
  page: number;
  /** [x1, y1, x2, y2] in PDF units, from the bottom left of the page. */
  rect: [number, number, number, number];
  /** The destination's name when it is a named destination, else null. */
  destName: string | null;
  /** The index of the page the destination is on, from 0, or null when it does not resolve. */
  destPage: number | null;
  /** The annotation's /Contents text, or null when it has none. */
  contents: string | null;
}

export interface PdfOutlineItem {
  title: string;
  /** The nesting depth in the outline tree: 0 for a child of the outline root. */
  depth: number;
  destName: string | null;
  destPage: number | null;
}

export interface PdfLinks {
  pageCount: number;
  links: PdfLink[];
  outline: PdfOutlineItem[];
  /** How many annotations of any subtype each page has. */
  annotsPerPage: number[];
}

/** The indirect objects of a PDF by number, object streams included. */
export function pdfObjects(pdf: Uint8Array): Map<number, PdfValue> {
  const raw = Buffer.from(pdf).toString('latin1');
  const objects = new Map<number, PdfValue>();
  const streams: Array<{ dict: Dict; data: string }> = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const lx = new Lexer(raw, m.index + m[0].length);
    let v: PdfValue;
    try {
      v = lx.value();
    } catch {
      continue;
    }
    objects.set(Number(m[1]), v);
    if (lx.peekWord() === 'stream') {
      let start = lx.pos + 'stream'.length;
      if (raw[start] === '\r') start++;
      if (raw[start] === '\n') start++;
      const len = isDict(v) ? v.v['Length'] : undefined;
      const end = typeof len === 'number' ? start + len : raw.indexOf('endstream', start);
      if (isDict(v)) streams.push({ dict: v.v, data: raw.slice(start, end) });
      re.lastIndex = Math.max(end, re.lastIndex);
    }
  }
  for (const { dict, data } of streams) {
    if (nameOf(dict['Type']) !== 'ObjStm') continue;
    const filter = nameOf(dict['Filter']);
    const body =
      filter === 'FlateDecode' ? inflateSync(Buffer.from(data, 'latin1')).toString('latin1') : data;
    const n = dict['N'];
    const first = dict['First'];
    if (typeof n !== 'number' || typeof first !== 'number') continue;
    const head = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[2 * i]!;
      const off = head[2 * i + 1]!;
      const lx = new Lexer(body, first + off);
      try {
        objects.set(num, lx.value());
      } catch {
        // not readable by this reader
      }
    }
  }
  return objects;
}

/** The link annotations, named destinations and outline of a PDF. */
export function pdfLinks(pdf: Uint8Array): PdfLinks {
  const objects = pdfObjects(pdf);
  const get = (v: PdfValue | undefined): PdfValue | undefined => {
    let x = v;
    for (let i = 0; i < 32 && isRef(x); i++) x = objects.get(x.n);
    return x;
  };
  const dict = (v: PdfValue | undefined): Dict | null => {
    const x = get(v);
    return isDict(x) ? x.v : null;
  };
  let catalog: Dict | null = null;
  for (const v of objects.values())
    if (isDict(v) && nameOf(v.v['Type']) === 'Catalog') catalog = v.v;
  if (!catalog) throw new Error('the PDF has no catalogue');

  // The page tree, in order.
  const pages: number[] = [];
  const walk = (ref: PdfValue | undefined, depth: number): void => {
    if (!isRef(ref) || depth > 64) return;
    const d = dict(ref);
    if (!d) return;
    if (nameOf(d['Type']) === 'Page') pages.push(ref.n);
    else for (const k of (get(d['Kids']) as PdfValue[] | undefined) ?? []) walk(k, depth + 1);
  };
  walk(catalog['Pages'], 0);

  // Named destinations.
  const named = new Map<string, PdfValue>();
  const tree = (node: PdfValue | undefined, depth: number): void => {
    const d = dict(node);
    if (!d || depth > 64) return;
    const names = get(d['Names']);
    if (Array.isArray(names))
      for (let i = 0; i + 1 < names.length; i += 2) {
        const key = strOf(names[i]);
        if (key !== null) named.set(key, names[i + 1]!);
      }
    const kids = get(d['Kids']);
    if (Array.isArray(kids)) for (const k of kids) tree(k, depth + 1);
  };
  tree(dict(catalog['Names'])?.['Dests'], 0);
  const oldDests = dict(catalog['Dests']);
  if (oldDests) for (const [k, v] of Object.entries(oldDests)) named.set(k, v);

  const pageOfArray = (v: PdfValue | undefined): number | null => {
    let x = get(v);
    if (isDict(x)) x = get(x.v['D']);
    if (!Array.isArray(x) || !isRef(x[0])) return null;
    const i = pages.indexOf(x[0].n);
    return i < 0 ? null : i;
  };
  const resolve = (
    dest: PdfValue | undefined,
  ): { destName: string | null; destPage: number | null } => {
    const x = get(dest);
    const key = strOf(x) ?? nameOf(x);
    if (key !== null) return { destName: key, destPage: pageOfArray(named.get(key)) };
    return { destName: null, destPage: pageOfArray(x) };
  };
  const destOf = (d: Dict): PdfValue | undefined => {
    if (d['Dest'] !== undefined) return d['Dest'];
    const a = dict(d['A']);
    if (a && nameOf(a['S']) === 'GoTo') return a['D'];
    return undefined;
  };

  const links: PdfLink[] = [];
  const annotsPerPage: number[] = [];
  pages.forEach((p, index) => {
    const annots = get(dict({ kind: 'ref', n: p })?.['Annots']);
    const list = Array.isArray(annots) ? annots : [];
    annotsPerPage.push(list.length);
    for (const a of list) {
      const d = dict(a);
      if (!d || nameOf(d['Subtype']) !== 'Link') continue;
      const rect = (get(d['Rect']) as number[] | undefined) ?? [];
      links.push({
        page: index,
        rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!],
        ...resolve(destOf(d)),
        contents: d['Contents'] === undefined ? null : textString(strOf(get(d['Contents'])) ?? ''),
      });
    }
  });

  const outline: PdfOutlineItem[] = [];
  const items = (first: PdfValue | undefined, depth: number): void => {
    let cur = first;
    for (let i = 0; i < 10_000 && depth < 32; i++) {
      const d = dict(cur);
      if (!d) return;
      outline.push({
        title: textString(strOf(get(d['Title'])) ?? ''),
        depth,
        ...resolve(destOf(d)),
      });
      items(d['First'], depth + 1);
      cur = d['Next'];
    }
  };
  items(dict(catalog['Outlines'])?.['First'], 0);

  return { pageCount: pages.length, links, outline, annotsPerPage };
}
