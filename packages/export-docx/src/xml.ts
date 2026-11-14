/**
 * A small XML parser for OOXML parts that keeps byte offsets (ADR 0017, part 1).
 *
 * - It works on the bytes, so every element knows the byte range of its start tag, its content and
 *   its end tag. The writer copies unedited elements by range, without decoding and encoding them.
 * - It resolves namespaces, so names can be compared by namespace URI and local name, spelt as
 *   names.ts spells them (`w:val`, or `{uri}local` for a namespace without a registered prefix).
 * - It refuses document type declarations (09 §12, EXP-099), and with them every entity except the
 *   five predefined ones and character references. No input can make it expand or fetch anything.
 * - It accepts UTF-8 only. Word writes UTF-8; a UTF-16 part is refused rather than misread.
 *
 * Written by hand because none of the parsers in the borrow list (SPK-026 §5.2) reports byte
 * offsets of start-tag ends and resolved namespaces together; see the S11 report.
 */
import { pname } from './names.ts';
import { decodeUtf8 } from './utf8.ts';

export class XmlError extends Error {
  override name = 'XmlError';
}

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface XmlAttribute {
  qname: string;
  prefix: string;
  local: string;
  /** Resolved namespace URI; '' when the attribute has no prefix. */
  ns: string;
  /** Decoded and normalised value (XML 1.0 §3.3.3). */
  value: string;
  start: number;
  end: number;
}

export interface XmlElement {
  kind: 'element';
  qname: string;
  prefix: string;
  local: string;
  ns: string;
  /** Attributes other than namespace declarations, in document order. */
  attrs: XmlAttribute[];
  /** `xmlns` and `xmlns:*` declarations on this element. */
  nsDecls: XmlAttribute[];
  /** Prefix to URI bindings in scope at this element ('' is the default namespace). */
  scope: ReadonlyMap<string, string>;
  children: XmlNode[];
  parent: XmlElement | null;
  /** Offset of `<`. */
  start: number;
  /** Offset just after the start tag's `>`. */
  startTagEnd: number;
  /** Offset of `</`; equals startTagEnd for an empty-element tag. */
  endTagStart: number;
  /** Offset just after the element. */
  end: number;
  selfClosing: boolean;
}

export interface XmlText {
  kind: 'text';
  start: number;
  end: number;
  cdata: boolean;
  value: string;
}

export interface XmlComment {
  kind: 'comment';
  start: number;
  end: number;
  value: string;
}

export interface XmlPI {
  kind: 'pi';
  start: number;
  end: number;
  target: string;
  value: string;
}

export type XmlNode = XmlElement | XmlText | XmlComment | XmlPI;

export interface XmlDocument {
  bytes: Uint8Array;
  root: XmlElement;
  /** The encoding named in the XML declaration, if any. */
  encoding: string | null;
}

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQ = 0x3d;

const isSpace = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

function indexOfSeq(bytes: Uint8Array, seq: number[], from: number): number {
  const first = seq[0]!;
  let i = from;
  for (;;) {
    i = bytes.indexOf(first, i);
    if (i < 0) return -1;
    let ok = true;
    for (let k = 1; k < seq.length; k++)
      if (bytes[i + k] !== seq[k]) {
        ok = false;
        break;
      }
    if (ok) return i;
    i++;
  }
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const SEQ_PI_END = ascii('?>');
const SEQ_COMMENT = ascii('<!--');
const SEQ_COMMENT_END = ascii('-->');
const SEQ_CDATA = ascii('<![CDATA[');
const SEQ_CDATA_END = ascii(']]>');
const SEQ_DOCTYPE = ascii('<!DOCTYPE');

function startsWithSeq(bytes: Uint8Array, seq: number[], at: number): boolean {
  for (let k = 0; k < seq.length; k++) if (bytes[at + k] !== seq[k]) return false;
  return true;
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeReference(s: string, at: number, out: string[]): number {
  const semi = s.indexOf(';', at + 1);
  if (semi < 0) throw new XmlError(`unterminated reference near "${s.slice(at, at + 12)}"`);
  const body = s.slice(at + 1, semi);
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const cp = parseInt(body.slice(2), 16);
    if (!/^[0-9A-Fa-f]+$/.test(body.slice(2)) || !isXmlChar(cp))
      throw new XmlError(`invalid character reference &${body};`);
    out.push(String.fromCodePoint(cp));
  } else if (body.startsWith('#')) {
    const cp = parseInt(body.slice(1), 10);
    if (!/^[0-9]+$/.test(body.slice(1)) || !isXmlChar(cp))
      throw new XmlError(`invalid character reference &${body};`);
    out.push(String.fromCodePoint(cp));
  } else {
    const v = PREDEFINED[body];
    if (v === undefined)
      throw new XmlError(`undeclared entity &${body}; (only the predefined entities are allowed)`);
    out.push(v);
  }
  return semi + 1;
}

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** Text content: line ends normalised, references resolved. */
function decodeText(raw: string): string {
  if (raw.indexOf('&') < 0 && raw.indexOf('\r') < 0) return raw;
  const s = raw.indexOf('\r') < 0 ? raw : raw.replace(/\r\n?/g, '\n');
  if (s.indexOf('&') < 0) return s;
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, amp));
    i = decodeReference(s, amp, out);
  }
  return out.join('');
}

/** Attribute value normalisation (XML 1.0 §3.3.3, CDATA attributes). */
function decodeAttr(raw: string): string {
  if (raw.indexOf('&') < 0 && !/[\t\n\r]/.test(raw)) return raw;
  const s = raw.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' ');
  if (s.indexOf('&') < 0) return s;
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, amp));
    i = decodeReference(s, amp, out);
  }
  return out.join('');
}

function splitName(qname: string): [string, string] {
  const c = qname.indexOf(':');
  return c < 0 ? ['', qname] : [qname.slice(0, c), qname.slice(c + 1)];
}

const ROOT_SCOPE: ReadonlyMap<string, string> = new Map([['xml', XML_NS]]);

/** Parses a part. Throws XmlError for anything that is not well-formed, namespace-valid UTF-8. */
export function parseXml(bytes: Uint8Array): XmlDocument {
  const n = bytes.length;
  if (
    n >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  )
    throw new XmlError('UTF-16 parts are not supported');
  let pos = n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const contentStart = pos;
  let encoding: string | null = null;
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  const addChild = (node: XmlNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (node.kind === 'text') {
      if (!/^[ \t\r\n]*$/.test(node.value)) throw new XmlError('text outside the root element');
    } else if (node.kind === 'element') {
      if (root) throw new XmlError('more than one root element');
    }
  };

  while (pos < n) {
    const lt = bytes.indexOf(LT, pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos) {
      const raw = decodeUtf8(bytes, pos, textEnd);
      addChild({ kind: 'text', start: pos, end: textEnd, cdata: false, value: decodeText(raw) });
    }
    if (lt < 0) break;
    const c1 = bytes[lt + 1];
    if (c1 === QUESTION) {
      const close = indexOfSeq(bytes, SEQ_PI_END, lt + 2);
      if (close < 0) throw new XmlError(`unterminated processing instruction at byte ${lt}`);
      const body = decodeUtf8(bytes, lt + 2, close);
      const m = /^([^\s?]+)\s*([\s\S]*)$/.exec(body);
      const target = m?.[1] ?? '';
      if (target.toLowerCase() === 'xml') {
        if (lt !== contentStart || root || target !== 'xml')
          throw new XmlError('misplaced XML declaration');
        const enc = /encoding\s*=\s*["']([^"']+)["']/.exec(body)?.[1] ?? null;
        if (enc && enc.toLowerCase() !== 'utf-8' && enc.toLowerCase() !== 'utf8')
          throw new XmlError(`encoding ${enc} is not supported`);
        encoding = enc;
      } else addChild({ kind: 'pi', start: lt, end: close + 2, target, value: m?.[2] ?? '' });
      pos = close + 2;
      continue;
    }
    if (c1 === BANG) {
      if (startsWithSeq(bytes, SEQ_COMMENT, lt)) {
        const close = indexOfSeq(bytes, SEQ_COMMENT_END, lt + 4);
        if (close < 0) throw new XmlError(`unterminated comment at byte ${lt}`);
        addChild({
          kind: 'comment',
          start: lt,
          end: close + 3,
          value: decodeUtf8(bytes, lt + 4, close),
        });
        pos = close + 3;
        continue;
      }
      if (startsWithSeq(bytes, SEQ_CDATA, lt)) {
        if (!stack.length) throw new XmlError('CDATA outside the root element');
        const close = indexOfSeq(bytes, SEQ_CDATA_END, lt + 9);
        if (close < 0) throw new XmlError(`unterminated CDATA section at byte ${lt}`);
        const raw = decodeUtf8(bytes, lt + 9, close);
        addChild({
          kind: 'text',
          start: lt,
          end: close + 3,
          cdata: true,
          value: raw.replace(/\r\n?/g, '\n'),
        });
        pos = close + 3;
        continue;
      }
      if (startsWithSeq(bytes, SEQ_DOCTYPE, lt))
        throw new XmlError('document type declarations are refused (EXP-099)');
      throw new XmlError(`unexpected markup at byte ${lt}`);
    }
    if (c1 === SLASH) {
      let p = lt + 2;
      while (p < n && !isSpace(bytes[p]!) && bytes[p] !== GT) p++;
      const qname = decodeUtf8(bytes, lt + 2, p);
      while (p < n && isSpace(bytes[p]!)) p++;
      if (bytes[p] !== GT) throw new XmlError(`malformed end tag at byte ${lt}`);
      const el = stack.pop();
      if (!el || el.qname !== qname)
        throw new XmlError(
          `end tag </${qname}> does not match <${el?.qname ?? '(none)'}> at byte ${lt}`,
        );
      el.endTagStart = lt;
      el.end = p + 1;
      pos = p + 1;
      continue;
    }
    // Start tag.
    let p = lt + 1;
    while (p < n && !isSpace(bytes[p]!) && bytes[p] !== GT && bytes[p] !== SLASH) p++;
    if (p === lt + 1) throw new XmlError(`malformed start tag at byte ${lt}`);
    const qname = decodeUtf8(bytes, lt + 1, p);
    const rawAttrs: Array<{ qname: string; value: string; start: number; end: number }> = [];
    let selfClosing = false;
    for (;;) {
      while (p < n && isSpace(bytes[p]!)) p++;
      if (p >= n) throw new XmlError(`unterminated start tag <${qname}> at byte ${lt}`);
      const b = bytes[p]!;
      if (b === GT) {
        p++;
        break;
      }
      if (b === SLASH) {
        if (bytes[p + 1] !== GT) throw new XmlError(`malformed empty-element tag at byte ${p}`);
        selfClosing = true;
        p += 2;
        break;
      }
      const aStart = p;
      while (
        p < n &&
        !isSpace(bytes[p]!) &&
        bytes[p] !== EQ &&
        bytes[p] !== GT &&
        bytes[p] !== SLASH
      )
        p++;
      const aName = decodeUtf8(bytes, aStart, p);
      while (p < n && isSpace(bytes[p]!)) p++;
      if (bytes[p] !== EQ)
        throw new XmlError(`attribute ${aName} without a value at byte ${aStart}`);
      p++;
      while (p < n && isSpace(bytes[p]!)) p++;
      const quote = bytes[p];
      if (quote !== 0x22 && quote !== 0x27)
        throw new XmlError(`unquoted attribute ${aName} at byte ${aStart}`);
      const close = bytes.indexOf(quote, p + 1);
      if (close < 0) throw new XmlError(`unterminated attribute ${aName} at byte ${aStart}`);
      const raw = decodeUtf8(bytes, p + 1, close);
      if (raw.indexOf('<') >= 0) throw new XmlError(`"<" in attribute ${aName} at byte ${aStart}`);
      rawAttrs.push({ qname: aName, value: decodeAttr(raw), start: aStart, end: close + 1 });
      p = close + 1;
      if (p < n && !isSpace(bytes[p]!) && bytes[p] !== GT && bytes[p] !== SLASH)
        throw new XmlError(`no space between attributes at byte ${p}`);
    }
    const parent = stack[stack.length - 1] ?? null;
    const parentScope = parent ? parent.scope : ROOT_SCOPE;
    const nsDecls: XmlAttribute[] = [];
    const attrs: XmlAttribute[] = [];
    let scope = parentScope;
    const seen = new Set<string>();
    for (const a of rawAttrs) {
      if (seen.has(a.qname)) throw new XmlError(`attribute ${a.qname} appears twice on <${qname}>`);
      seen.add(a.qname);
      const [prefix, local] = splitName(a.qname);
      if (a.qname === 'xmlns' || prefix === 'xmlns') {
        if (scope === parentScope) scope = new Map(parentScope);
        (scope as Map<string, string>).set(prefix === 'xmlns' ? local : '', a.value);
        nsDecls.push({ ...a, prefix, local, ns: XMLNS_NS });
      }
    }
    for (const a of rawAttrs) {
      const [prefix, local] = splitName(a.qname);
      if (a.qname === 'xmlns' || prefix === 'xmlns') continue;
      let ns = '';
      if (prefix) {
        const uri = scope.get(prefix);
        if (uri === undefined)
          throw new XmlError(`unbound prefix ${prefix} on attribute ${a.qname}`);
        ns = uri;
      }
      attrs.push({ ...a, prefix, local, ns });
    }
    const [prefix, local] = splitName(qname);
    const ns = scope.get(prefix);
    if (prefix && ns === undefined) throw new XmlError(`unbound prefix ${prefix} on <${qname}>`);
    const el: XmlElement = {
      kind: 'element',
      qname,
      prefix,
      local,
      ns: ns ?? '',
      attrs,
      nsDecls,
      scope,
      children: [],
      parent,
      start: lt,
      startTagEnd: p,
      endTagStart: p,
      end: p,
      selfClosing,
    };
    addChild(el);
    if (!parent) root = el;
    if (!selfClosing) stack.push(el);
    pos = p;
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1]!.qname}>`);
  if (!root) throw new XmlError('no root element');
  return { bytes, root, encoding };
}

// ---------------------------------------------------------------------------------------------
// Navigation.

/** The name of an element or attribute, spelt as names.ts spells it. */
export const nameOf = (el: XmlElement | XmlAttribute): string => pname(el.ns, el.local);

export function elements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.kind === 'element') out.push(c);
  return out;
}

export function child(el: XmlElement, ns: string, local: string): XmlElement | undefined {
  for (const c of el.children)
    if (c.kind === 'element' && c.local === local && c.ns === ns) return c;
  return undefined;
}

export function attr(el: XmlElement, ns: string, local: string): string | undefined {
  for (const a of el.attrs) if (a.local === local && a.ns === ns) return a.value;
  return undefined;
}

export function is(el: XmlNode | undefined, ns: string, local: string): el is XmlElement {
  return !!el && el.kind === 'element' && el.ns === ns && el.local === local;
}

/** Concatenated text of all descendant text nodes, in document order (iterative: no depth limit). */
export function textContent(el: XmlElement): string {
  const out: string[] = [];
  const stack: XmlNode[] = [el];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === 'text') out.push(n.value);
    else if (n.kind === 'element')
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out.join('');
}

export function isWhitespaceText(n: XmlNode): boolean {
  return n.kind === 'text' && !n.cdata && /^[ \t\r\n]*$/.test(n.value);
}

// ---------------------------------------------------------------------------------------------
// Escaping.

export function escapeText(s: string): string {
  return s.replace(/[&<>\r]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#xD;',
  );
}

export function escapeAttr(s: string): string {
  return s.replace(/[&<>"\t\n\r]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\t':
        return '&#x9;';
      case '\n':
        return '&#xA;';
      default:
        return '&#xD;';
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Canonical XML for comparisons (the R1 (b) tolerance, see the S11 report §5).

export interface CanonicalOptions {
  /** Elements to leave out, with their subtrees (for example the elements Word regenerates). */
  skip?: (el: XmlElement) => boolean;
}

/**
 * Canonical text of an element: names spelt by namespace URI (names.ts), never by the part's own
 * prefixes, attributes sorted by name, namespace declarations left out, references resolved,
 * `<a/>` and `<a></a>` the same, and whitespace-only text left out where the parent also has
 * element children.
 */
export function canonical(el: XmlElement, opts: CanonicalOptions = {}): string {
  const out: string[] = [];
  // Iterative, so that hostile nesting cannot exhaust the stack.
  const stack: Array<XmlNode | { close: string }> = [el];
  while (stack.length) {
    const item = stack.pop()!;
    if ('close' in item) {
      out.push('</', item.close, '>');
      continue;
    }
    const e = item;
    if (e.kind === 'text') {
      out.push(escapeText(e.value));
      continue;
    }
    if (e.kind === 'comment') {
      out.push('<!--', e.value, '-->');
      continue;
    }
    if (e.kind === 'pi') {
      out.push('<?', e.target, ' ', e.value, '?>');
      continue;
    }
    const name = nameOf(e);
    out.push('<', name);
    const attrs = e.attrs
      .map((a) => [nameOf(a), a.value] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    for (const [k, v] of attrs) out.push(' ', k, '="', escapeAttr(v), '"');
    out.push('>');
    stack.push({ close: name });
    const hasElements = e.children.some((c) => c.kind === 'element');
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element' && opts.skip?.(c)) continue;
      if (c.kind === 'text' && hasElements && isWhitespaceText(c)) continue;
      stack.push(c);
    }
  }
  return out.join('');
}
