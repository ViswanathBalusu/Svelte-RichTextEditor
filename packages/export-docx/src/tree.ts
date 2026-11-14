/**
 * Element trees: the JSON form of preserved XML (ADR 0017, part 2; 03 §4.6). Names are spelt as
 * names.ts spells them (`w:val` for a registered namespace, `{uri}local` for any other), attribute
 * values and text are strings. The writer serialises them with its own escaping, so a hostile value
 * cannot inject markup.
 */
import { PRESERVED_BYTES, PRESERVED_DEPTH } from '@docedit/model/definition';
import { checkGrammar } from '@docedit/model/validate';
import { registeredPrefix, splitPname } from './names.ts';
import {
  type XmlElement,
  XML_NS,
  escapeAttr,
  escapeText,
  isWhitespaceText,
  nameOf,
} from './xml.ts';

export interface TreeElement {
  name: string;
  attrs?: Record<string, string>;
  children?: TreeNode[];
}
export interface TreeText {
  text: string;
}
export type TreeNode = TreeElement | TreeText;
/** The top level of a `preserved` value: the node implies the element, so it has no name. */
export interface TreeBody {
  attrs?: Record<string, string>;
  children?: TreeNode[];
}
/** A shared tree: the tree of the `preserved_def` with this identifier (spike S11, model change 4). */
export interface TreeRef {
  ref: string;
}

export interface TreeGrammar {
  kind: 'elementTree';
  maxBytes: number;
  maxDepth: number;
}

/** The grammar of 03 §4.6 as the model declares it: depth 12, 16 KiB. */
export const PRESERVED_GRAMMAR: TreeGrammar = {
  kind: 'elementTree',
  maxBytes: PRESERVED_BYTES,
  maxDepth: PRESERVED_DEPTH,
};

export const isTreeText = (n: TreeNode): n is TreeText => 'text' in n;
export const isTreeRef = (v: unknown): v is TreeRef =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['ref'] === 'string';

export class NotRepresentable extends Error {
  override name = 'NotRepresentable';
}

/**
 * Converts a parsed element to a tree. Whitespace-only text between elements is left out (it is
 * insignificant in OOXML and ignored by the R1 comparison); comments and processing instructions
 * have no place in the grammar, so an element containing one is not representable. Nesting deeper
 * than `maxDepth` is not representable either, which also bounds the recursion on hostile input.
 */
export function toTree(
  el: XmlElement,
  drop?: (c: XmlElement) => boolean,
  maxDepth = PRESERVED_DEPTH + 1,
): TreeElement {
  if (maxDepth <= 0) throw new NotRepresentable(`<${el.qname}> is nested too deeply`);
  const out: TreeElement = { name: nameOf(el) };
  if (el.attrs.length) {
    out.attrs = {};
    for (const a of el.attrs) out.attrs[nameOf(a)] = a.value;
  }
  const hasElements = el.children.some((c) => c.kind === 'element');
  const children: TreeNode[] = [];
  for (const c of el.children) {
    if (c.kind === 'element') {
      if (!drop?.(c)) children.push(toTree(c, drop, maxDepth - 1));
    } else if (c.kind === 'text') {
      if (hasElements && isWhitespaceText(c)) continue;
      if (c.value) children.push({ text: c.value });
    } else throw new NotRepresentable(`<${el.qname}> contains a ${c.kind}`);
  }
  if (children.length) out.children = children;
  return out;
}

export function treeDepth(body: TreeBody): number {
  const depth = (n: TreeNode, d: number): number =>
    isTreeText(n) ? d - 1 : Math.max(d, ...(n.children ?? []).map((c) => depth(c, d + 1)));
  return Math.max(1, ...(body.children ?? []).map((c) => depth(c, 2)));
}

/** Problems with a `preserved` value under the grammar; empty when it is valid. */
export function checkPreserved(body: TreeBody, grammar: TreeGrammar = PRESERVED_GRAMMAR): string[] {
  return checkGrammar(grammar, body, '/preserved');
}

const sortedEntries = (r: Record<string, string> | undefined): Array<[string, string]> =>
  Object.entries(r ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** The same canonical text as xml.ts `canonical()` produces for the equivalent element. */
export function canonicalTree(el: TreeElement): string {
  const out: string[] = [];
  const walk = (e: TreeElement): void => {
    out.push('<', e.name);
    for (const [k, v] of sortedEntries(e.attrs)) out.push(' ', k, '="', escapeAttr(v), '"');
    out.push('>');
    const kids = e.children ?? [];
    const hasElements = kids.some((c) => !isTreeText(c));
    for (const c of kids) {
      if (isTreeText(c)) {
        if (hasElements && /^[ \t\r\n]*$/.test(c.text)) continue;
        out.push(escapeText(c.text));
      } else walk(c);
    }
    out.push('</', e.name, '>');
  };
  walk(el);
  return out.join('');
}

/**
 * Chooses prefixes for namespaces while serialising into a part. The part's root declarations are
 * in scope everywhere; a namespace without a binding gets its registered prefix where that prefix
 * is free (otherwise `ns0`, `ns1`, ...), declared on the element that first needs it.
 */
export class NamespaceWriter {
  private readonly prefixOf = new Map<string, string>();
  private readonly uriOf = new Map<string, string>();

  constructor(rootScope: ReadonlyMap<string, string>) {
    for (const [prefix, uri] of rootScope) {
      if (!prefix || prefix === 'xml') continue;
      if (!this.prefixOf.has(uri)) this.prefixOf.set(uri, prefix);
      this.uriOf.set(prefix, uri);
    }
  }

  /** The prefix bound at the root for a namespace, if any. */
  rootPrefix(uri: string): string | undefined {
    return this.prefixOf.get(uri);
  }

  /** The URI a prefix is bound to at the root, if any. */
  rootUri(prefix: string): string | undefined {
    return this.uriOf.get(prefix);
  }

  qname(name: string, local: Map<string, string>, decls: string[]): string {
    const [uri, l] = splitPname(name);
    if (!uri) return l;
    if (uri === XML_NS) return `xml:${l}`;
    let p = local.get(uri) ?? this.prefixOf.get(uri);
    if (p === undefined) {
      const used = new Set([...this.uriOf.keys(), ...local.values()]);
      const wanted = registeredPrefix(uri);
      p = wanted && !used.has(wanted) ? wanted : undefined;
      for (let k = 0; p === undefined; k++) if (!used.has(`ns${k}`)) p = `ns${k}`;
      local.set(uri, p);
      decls.push(` xmlns:${p}="${escapeAttr(uri)}"`);
    }
    return `${p}:${l}`;
  }

  /** Serialises a tree element (and its subtree). */
  element(el: TreeElement, inherited: Map<string, string> = new Map()): string {
    const local = new Map(inherited);
    const decls: string[] = [];
    const qn = this.qname(el.name, local, decls);
    const attrs: string[] = [];
    for (const [k, v] of Object.entries(el.attrs ?? {}))
      attrs.push(` ${this.qname(k, local, decls)}="${escapeAttr(v)}"`);
    const kids = el.children ?? [];
    if (!kids.length) return `<${qn}${decls.join('')}${attrs.join('')}/>`;
    const inner = kids
      .map((c) => (isTreeText(c) ? escapeText(c.text) : this.element(c, local)))
      .join('');
    return `<${qn}${decls.join('')}${attrs.join('')}>${inner}</${qn}>`;
  }

  /** Serialises attributes only (for start tags the writer builds itself). */
  attributes(attrs: Record<string, string>, local: Map<string, string>, decls: string[]): string {
    return Object.entries(attrs)
      .map(([k, v]) => ` ${this.qname(k, local, decls)}="${escapeAttr(v)}"`)
      .join('');
  }
}

/** A deep copy without the attributes named. */
export function withoutAttrs(el: TreeElement, names: readonly string[]): TreeElement {
  const out: TreeElement = { name: el.name };
  const attrs = Object.entries(el.attrs ?? {}).filter(([k]) => !names.includes(k));
  if (attrs.length) out.attrs = Object.fromEntries(attrs);
  if (el.children?.length) out.children = el.children;
  return out;
}

/** The element children (property containers hold no significant text). */
export const elementsOf = (nodes: readonly TreeNode[] | undefined): TreeElement[] =>
  (nodes ?? []).filter((n): n is TreeElement => !isTreeText(n));

export const hasContent = (el: TreeElement): boolean =>
  Object.keys(el.attrs ?? {}).length > 0 || (el.children?.length ?? 0) > 0;

/**
 * An identity-bound attribute taken out of a preserved tree (EXP-116): the child path from the
 * body's children to the element, and the values. The source map keeps these, never the document.
 */
export interface IdentityEntry {
  path: number[];
  attrs: Record<string, string>;
}

/**
 * Removes the attributes named in `names` from every element of `body`'s children, at any depth,
 * and returns them with their paths. The body is changed in place; the caller keeps the entries.
 */
export function splitIdentity(body: TreeBody, names: ReadonlySet<string>): IdentityEntry[] {
  const out: IdentityEntry[] = [];
  // The body's own attributes (path []): a w:p, w:tbl, w:tr or w:tc keeps its rsid values there.
  if (body.attrs) {
    const taken: Record<string, string> = {};
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.attrs)) (names.has(k) ? taken : kept)[k] = v;
    if (Object.keys(taken).length) {
      out.push({ path: [], attrs: taken });
      if (Object.keys(kept).length) body.attrs = kept;
      else delete body.attrs;
    }
  }
  const walk = (children: readonly TreeNode[] | undefined, path: number[]): void => {
    children?.forEach((c, i) => {
      if (isTreeText(c)) return;
      const here = [...path, i];
      if (c.attrs) {
        const taken: Record<string, string> = {};
        const kept: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.attrs)) (names.has(k) ? taken : kept)[k] = v;
        if (Object.keys(taken).length) {
          out.push({ path: here, attrs: taken });
          if (Object.keys(kept).length) c.attrs = kept;
          else delete c.attrs;
        }
      }
      walk(c.children, here);
    });
  };
  walk(body.children, []);
  return out;
}

/**
 * Returns a copy of `body` with the identity-bound attributes of `entries` put back at their
 * paths. Entries whose path no longer exists are ignored. The body itself is not changed.
 */
export function restoreIdentity(
  body: TreeBody,
  entries: readonly IdentityEntry[] | undefined,
): TreeBody {
  if (!entries?.length) return body;
  const copy = JSON.parse(JSON.stringify(body)) as TreeBody;
  for (const e of entries) {
    let list: TreeNode[] | undefined = copy.children;
    let target: TreeElement | undefined;
    if (!e.path.length) {
      copy.attrs = { ...(copy.attrs ?? {}), ...e.attrs };
      continue;
    }
    for (const i of e.path) {
      const node: TreeNode | undefined = list?.[i];
      if (!node || isTreeText(node)) {
        target = undefined;
        break;
      }
      target = node;
      list = node.children;
    }
    if (target) target.attrs = { ...(target.attrs ?? {}), ...e.attrs };
  }
  return copy;
}
