/**
 * A reader for the structure tree of a tagged PDF (test helper, Node.js only; EXP-111, EXP-112).
 *
 * It reads the objects of a PDF written by LuaTeX: the plain `n 0 obj` objects and the ones inside
 * Flate object streams. It then walks `/StructTreeRoot` and returns the structure elements as a
 * tree. Each element has its own tag (`/S`), the standard tag it is role-mapped to (PDF 2.0
 * namespaces: tagpdf writes LaTeX's names and maps them), its language, alternative text, actual
 * text, attributes and children. Marked-content references are kept as `mcids`.
 *
 * It is not a general PDF parser: no encryption, no incremental updates, no cross-reference check.
 */
import { inflateSync } from 'node:zlib';

export type PdfValue =
  null | boolean | number | string | PdfName | PdfRef | PdfValue[] | { [key: string]: PdfValue };

export class PdfName {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}
export class PdfRef {
  readonly num: number;
  constructor(num: number) {
    this.num = num;
  }
}
type Dict = { [key: string]: PdfValue };

const isDict = (v: PdfValue | undefined): v is Dict =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof PdfName) &&
  !(v instanceof PdfRef);

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/** Parses one PDF value at `at`; returns the value and the position after it. */
function parseValue(s: string, start: number): [PdfValue, number] {
  let at = start;
  const skip = (): void => {
    for (;;) {
      while (at < s.length && WS.has(s[at]!)) at++;
      if (s[at] === '%') while (at < s.length && s[at] !== '\n' && s[at] !== '\r') at++;
      else return;
    }
  };
  skip();
  const c = s[at];
  if (c === undefined) return [null, at];
  if (c === '<' && s[at + 1] === '<') {
    at += 2;
    const dict: Dict = {};
    for (;;) {
      skip();
      if (s[at] === '>' && s[at + 1] === '>') return [dict, at + 2];
      if (s[at] !== '/') throw new Error(`a dictionary key is expected at ${at}`);
      const [key, afterKey] = parseValue(s, at);
      const [value, afterValue] = parseValue(s, afterKey);
      dict[(key as PdfName).name] = value;
      at = afterValue;
    }
  }
  if (c === '[') {
    at++;
    const list: PdfValue[] = [];
    for (;;) {
      skip();
      if (s[at] === ']') return [list, at + 1];
      if (at >= s.length) throw new Error('an array does not end');
      const [value, after] = parseValue(s, at);
      list.push(value);
      at = after;
    }
  }
  if (c === '/') {
    let end = at + 1;
    while (end < s.length && !WS.has(s[end]!) && !DELIM.has(s[end]!)) end++;
    const name = s
      .slice(at + 1, end)
      .replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return [new PdfName(name), end];
  }
  if (c === '(') {
    let depth = 1;
    let out = '';
    at++;
    while (at < s.length && depth > 0) {
      const ch = s[at]!;
      if (ch === '\\') {
        const n = s[at + 1]!;
        const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (n in simple) out += simple[n];
        else if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(s.slice(at + 1, at + 4))![0];
          out += String.fromCharCode(parseInt(oct, 8));
          at += oct.length - 1;
        } else if (n !== '\n' && n !== '\r') out += n;
        at += 2;
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth > 0) out += ch;
      at++;
    }
    return [decodeText(out), at];
  }
  if (c === '<') {
    const end = s.indexOf('>', at);
    const hex = s.slice(at + 1, end).replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i < hex.length; i += 2)
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
    return [decodeText(out), end + 1];
  }
  let end = at;
  while (end < s.length && !WS.has(s[end]!) && !DELIM.has(s[end]!)) end++;
  const word = s.slice(at, end);
  if (word === 'true') return [true, end];
  if (word === 'false') return [false, end];
  if (word === 'null') return [null, end];
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
    const ref = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(s.slice(end, end + 24));
    if (ref && /^\d+$/.test(word)) return [new PdfRef(Number(word)), end + ref[0].length];
    return [Number(word), end];
  }
  throw new Error(`an unknown token '${word.slice(0, 20)}' at ${at}`);
}

/** A text string: UTF-16BE with a byte order mark, UTF-8 with one, or PDFDocEncoding (as latin1). */
function decodeText(bytes: string): string {
  if (bytes.startsWith('þÿ')) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  if (bytes.startsWith('ï»¿')) return Buffer.from(bytes.slice(3), 'latin1').toString('utf8');
  return bytes;
}

/** Every object of the file by number, with the inflated stream of an object when it has one. */
export function pdfObjects(pdf: Uint8Array): Map<number, PdfValue> {
  const raw = Buffer.from(pdf).toString('latin1');
  const objects = new Map<number, PdfValue>();
  const re = /(?:^|[\r\n])(\d+) 0 obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const num = Number(m[1]);
    const bodyAt = m.index + m[0].length;
    let value: PdfValue;
    let after: number;
    try {
      [value, after] = parseValue(raw, bodyAt);
    } catch {
      continue;
    }
    objects.set(num, value);
    const tail = /^\s*stream\r?\n/.exec(raw.slice(after, after + 400));
    if (!tail || !isDict(value)) continue;
    const start = after + tail[0].length;
    const end = raw.indexOf('endstream', start);
    re.lastIndex = end;
    const type = value['Type'];
    if (!(type instanceof PdfName) || type.name !== 'ObjStm') continue;
    let inner: string;
    try {
      inner = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    const n = value['N'] as number;
    const first = value['First'] as number;
    const head = inner.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const objNum = head[2 * i]!;
      const offset = head[2 * i + 1]!;
      try {
        objects.set(objNum, parseValue(inner, first + offset)[0]);
      } catch {
        // An object this reader cannot parse is left out.
      }
    }
  }
  return objects;
}

export interface StructNode {
  /** The element's own structure type (`/S`). */
  tag: string;
  /** The standard structure type it is role-mapped to; `tag` when no mapping is found. */
  role: string;
  lang?: string;
  alt?: string;
  actualText?: string;
  title?: string;
  /** The attribute dictionaries of `/A`, merged. */
  attrs: Record<string, PdfValue>;
  /** The marked-content identifiers that are direct children. */
  mcids: number[];
  /** Object references (`/OBJR`): annotations such as links. */
  objrs: number;
  kids: StructNode[];
}

const STANDARD = new Set(
  (
    'Document DocumentFragment Part Sect Div Aside NonStruct P H H1 H2 H3 H4 H5 H6 H7 H8 Title FENote ' +
    'Sub Lbl Span Em Strong Link Annot Form Ruby RB RT RP Warichu WT WP L LI LBody Table TR TH TD ' +
    'THead TBody TFoot Caption Figure Formula Artifact Note Reference Code Quote BlockQuote Index ' +
    'TOC TOCI Private Art math'
  ).split(' '),
);

export interface StructTree {
  root: StructNode;
  /** `/Lang` of the document catalogue. */
  lang: string | undefined;
  /** The number of marked-content identifiers the tree refers to. */
  mcidCount: number;
}

/** The structure tree of a tagged PDF, or null when the file has none. */
export function structTree(pdf: Uint8Array): StructTree | null {
  const objects = pdfObjects(pdf);
  const deref = (v: PdfValue | undefined): PdfValue =>
    v instanceof PdfRef ? (objects.get(v.num) ?? null) : (v ?? null);
  const typed = (name: string): Dict | undefined => {
    for (const v of objects.values())
      if (isDict(v) && v['Type'] instanceof PdfName && v['Type'].name === name) return v;
    return undefined;
  };
  const catalogue = typed('Catalog');
  const rootDict = deref(catalogue?.['StructTreeRoot']) ?? typed('StructTreeRoot');
  if (!isDict(rootDict)) return null;

  const plainMap = deref(rootDict['RoleMap']);
  const mapOnce = (tag: string, ns: PdfValue): [string, PdfValue] | null => {
    const nsDict = deref(ns);
    if (isDict(nsDict)) {
      const map = deref(nsDict['RoleMapNS']);
      const to = isDict(map) ? deref(map[tag]) : null;
      if (to instanceof PdfName) return [to.name, null];
      if (Array.isArray(to) && to[0] instanceof PdfName) return [to[0].name, to[1] ?? null];
      return null;
    }
    const to = isDict(plainMap) ? deref(plainMap[tag]) : null;
    return to instanceof PdfName ? [to.name, null] : null;
  };
  const role = (tag: string, ns: PdfValue): string => {
    let name = tag;
    let space = ns;
    for (let i = 0; i < 12; i++) {
      const next = mapOnce(name, space);
      if (!next) break;
      if (next[0] === name && deref(next[1]) === deref(space)) break;
      [name, space] = next;
    }
    return name;
  };

  let mcidCount = 0;
  const seen = new Set<PdfValue>();
  const build = (dict: Dict): StructNode => {
    const tag = dict['S'] instanceof PdfName ? dict['S'].name : 'StructTreeRoot';
    const node: StructNode = {
      tag,
      role: STANDARD.has(tag) && dict['NS'] === undefined ? tag : role(tag, dict['NS'] ?? null),
      attrs: {},
      mcids: [],
      objrs: 0,
      kids: [],
    };
    const text = (key: string): string | undefined => {
      const v = deref(dict[key]);
      return typeof v === 'string' ? v : undefined;
    };
    const lang = text('Lang');
    if (lang !== undefined) node.lang = lang;
    const alt = text('Alt');
    if (alt !== undefined) node.alt = alt;
    const actual = text('ActualText');
    if (actual !== undefined) node.actualText = actual;
    const title = text('T');
    if (title !== undefined) node.title = title;
    const attrs = deref(dict['A']);
    for (const a of Array.isArray(attrs) ? attrs : [attrs]) {
      const d = deref(a);
      if (isDict(d)) for (const [k, v] of Object.entries(d)) node.attrs[k] = deref(v);
    }
    // Attribute classes (`/C`) name entries of the root's `/ClassMap`, which tagpdf uses for the
    // table spans and scopes. Their attributes count as the element's own.
    const classMap = deref(rootDict['ClassMap']);
    const classes = deref(dict['C']);
    if (isDict(classMap))
      for (const c of Array.isArray(classes) ? classes : [classes]) {
        const entry = deref(c instanceof PdfName ? classMap[c.name] : null);
        for (const d of Array.isArray(entry) ? entry : [entry]) {
          const attrDict = deref(d);
          if (isDict(attrDict))
            for (const [k, v] of Object.entries(attrDict)) node.attrs[k] = deref(v);
        }
      }
    const kids = deref(dict['K']);
    for (const k of Array.isArray(kids) ? kids : kids === null ? [] : [kids]) {
      const kid = deref(k);
      if (typeof kid === 'number') {
        node.mcids.push(kid);
        mcidCount++;
      } else if (isDict(kid)) {
        const type = kid['Type'] instanceof PdfName ? kid['Type'].name : 'StructElem';
        if (type === 'MCR') {
          node.mcids.push(kid['MCID'] as number);
          mcidCount++;
        } else if (type === 'OBJR') node.objrs++;
        else if (!seen.has(kid)) {
          seen.add(kid);
          node.kids.push(build(kid));
        }
      }
    }
    return node;
  };
  const lang = deref(catalogue?.['Lang']);
  return {
    root: build(rootDict),
    lang: typeof lang === 'string' ? lang : undefined,
    mcidCount,
  };
}

/** Every element of the tree in document order (depth first). */
export function elements(node: StructNode): StructNode[] {
  return [node, ...node.kids.flatMap(elements)];
}

/** The elements whose standard role is `role`, in document order. */
export function byRole(tree: StructTree, role: string): StructNode[] {
  return elements(tree.root).filter((n) => n.role === role);
}

/** An outline of the tree for failure messages: one line per element, indented. */
export function outline(node: StructNode, depth = 0): string {
  const extra = [
    node.role !== node.tag ? `=${node.role}` : '',
    node.lang ? ` lang=${node.lang}` : '',
    node.alt !== undefined ? ` alt="${node.alt}"` : '',
    node.mcids.length ? ` mc=${node.mcids.length}` : '',
    node.objrs ? ` objr=${node.objrs}` : '',
    Object.keys(node.attrs).length ? ` A{${Object.keys(node.attrs).join(',')}}` : '',
  ].join('');
  return [
    `${'  '.repeat(depth)}${node.tag}${extra}`,
    ...node.kids.map((k) => outline(k, depth + 1)),
  ].join('\n');
}

/** The page content streams of the file, inflated, in file order (for artifact checks). */
export function contentStreams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end + 'endstream'.length;
    try {
      const text = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
      if (/\b(BT|BDC|BMC)\b/.test(text) && /\bET\b|\bEMC\b/.test(text)) out.push(text);
    } catch {
      // Not a Flate stream.
    }
  }
  return out;
}
