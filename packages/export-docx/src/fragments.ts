/**
 * Working on the XML of a fragment (ADR 0017, part 3; EXP-119) without changing anything else in
 * it: the fragment is parsed inside a wrapper that declares the namespace bindings it was taken
 * with, and edits replace exact byte ranges (an attribute's value, the end of a start tag), so
 * every byte outside an edit stays as the original part had it.
 */
import { utf8 } from '@docedit/model';
import type { Fragment } from './assets.ts';
import { NS } from './ooxml.ts';
import { decodeUtf8 } from './utf8.ts';
import { type XmlAttribute, type XmlElement, escapeAttr, parseXml } from './xml.ts';

export interface ByteEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits to bytes and returns the result as text. */
export function applyEdits(bytes: Uint8Array, edits: readonly ByteEdit[]): string {
  if (!edits.length) return decodeUtf8(bytes);
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) throw new Error('overlapping edits');
    out.push(decodeUtf8(bytes, pos, e.start), e.text);
    pos = e.end;
  }
  out.push(decodeUtf8(bytes, pos));
  return out.join('');
}

export interface ParsedFragment {
  /** The fragment's XML, as bytes. */
  bytes: Uint8Array;
  /** Its root element, with offsets relative to `bytes`. */
  root: XmlElement;
  /** Every element, in document order (offsets relative to `bytes`). */
  elements: XmlElement[];
}

const WRAP = 'docedit-fragment';

/** Parses a fragment's XML with the bindings it was taken with. Offsets are into the fragment's own bytes. */
export function parseFragment(f: Fragment): ParsedFragment {
  const decls = Object.entries(f.meta.namespaces)
    .map(([p, u]) => (p ? ` xmlns:${p}="${escapeAttr(u)}"` : ` xmlns="${escapeAttr(u)}"`))
    .join('');
  const head = utf8(`<${WRAP}${decls}>`);
  const bytes = utf8(f.xml);
  const all = new Uint8Array(head.length + bytes.length + WRAP.length + 3);
  all.set(head, 0);
  all.set(bytes, head.length);
  all.set(utf8(`</${WRAP}>`), head.length + bytes.length);
  const doc = parseXml(all);
  const shift = head.length;
  const elements: XmlElement[] = [];
  const relocate = (el: XmlElement): void => {
    el.start -= shift;
    el.startTagEnd -= shift;
    el.endTagStart -= shift;
    el.end -= shift;
    for (const a of el.attrs) {
      a.start -= shift;
      a.end -= shift;
    }
    elements.push(el);
    for (const c of el.children) if (c.kind === 'element') relocate(c);
  };
  const root = doc.root.children.find((c): c is XmlElement => c.kind === 'element');
  if (!root) throw new Error('a fragment without an element');
  relocate(root);
  return { bytes, root, elements };
}

/** An edit that sets an attribute's value, keeping its qualified name. */
export function setAttribute(a: XmlAttribute, value: string): ByteEdit {
  return { start: a.start, end: a.end, text: `${a.qname}="${escapeAttr(value)}"` };
}

/** An edit that adds attributes (or namespace declarations) at the end of an element's start tag. */
export function addToStartTag(el: XmlElement, text: string, bytes: Uint8Array): ByteEdit {
  // The start tag ends with `>` or `/>`; insert before either.
  let at = el.startTagEnd - 1;
  if (bytes[at - 1] === 0x2f) at--;
  return { start: at, end: at, text };
}

/** Attributes in the relationships namespace (`r:id`, `r:embed`, `r:link`, ...), with their elements. */
export function relationshipAttributes(
  pf: ParsedFragment,
): Array<{ el: XmlElement; attr: XmlAttribute }> {
  const out: Array<{ el: XmlElement; attr: XmlAttribute }> = [];
  for (const el of pf.elements)
    for (const a of el.attrs) if (a.ns === NS.r) out.push({ el, attr: a });
  return out;
}
