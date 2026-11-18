/**
 * The identified parts of a document (08 §6; 03 §9): every block-level node with an identifier, the
 * form fields and the definitions, with their positions, containers and regions. Comparisons and
 * restores align documents by these identifiers.
 *
 * The walk works on full documents and on projections (ADR 0019) alike: a projection's
 * `hidden_region` placeholder is a leaf block that carries the region's identifier and nothing else.
 */
import type { Mark, Node } from 'prosemirror-model';

/** Node types whose children are themselves identified blocks. */
const CONTAINERS: ReadonlySet<string> = new Set([
  'region',
  'table',
  'table_row',
  'table_cell',
  'story',
]);

/** The placeholder of a hidden region in a projection (ADR 0019; CDM-053). */
export const PLACEHOLDER = 'hidden_region';

export interface BlockEntry {
  /** The identifier, or a positional key starting with `#` for a node that has none. */
  id: string;
  type: string;
  node: Node;
  /** The position before the node. */
  pos: number;
  /** The key of the container: an identified ancestor, `#body`, or `#story:<id>`. */
  parent: string;
  /** The identifiers of identified ancestors, outermost first. */
  path: readonly string[];
  /** The region the block is in (a body child), or null. */
  region: string | null;
  /** Whether the block holds inline content compared token by token (it has no identified children). */
  leaf: boolean;
}

export interface FieldEntry {
  id: string;
  node: Node;
  pos: number;
  /** The leaf block that holds the field. */
  block: string;
  region: string | null;
}

export interface DefinitionEntry {
  /** `<type>/<id>`, or `settings` (07 §5.1: one scope per definition node). */
  key: string;
  type: string;
  id: string;
  node: Node;
  pos: number;
}

export interface DocIndex {
  doc: Node;
  blocks: Map<string, BlockEntry>;
  /** Blocks in document order. */
  order: BlockEntry[];
  /** Child block identifiers of each container, in order. */
  children: Map<string, string[]>;
  fields: Map<string, FieldEntry>;
  definitions: Map<string, DefinitionEntry>;
}

const idOf = (n: Node): string | null => {
  const id = n.attrs['id'];
  return typeof id === 'string' && id !== '' ? id : null;
};

/** The scope key of a definition node (07 §5.1; `defs:<type>/<id>` without the prefix). */
export function definitionKey(n: Node): string {
  if (n.type.name === 'settings') return 'settings';
  return `${n.type.name}/${idOf(n) ?? '?'}`;
}

/** Indexes the identified parts of a document. */
export function indexDocument(doc: Node): DocIndex {
  const index: DocIndex = {
    doc,
    blocks: new Map(),
    order: [],
    children: new Map(),
    fields: new Map(),
    definitions: new Map(),
  };
  const childList = (key: string): string[] => {
    let list = index.children.get(key);
    if (!list) {
      list = [];
      index.children.set(key, list);
    }
    return list;
  };

  const addBlock = (
    node: Node,
    pos: number,
    parent: string,
    path: readonly string[],
    region: string | null,
    siblingIndex: number,
  ): BlockEntry => {
    const own = idOf(node);
    // A node without an identifier is keyed by its place, so that it can never meet a real one.
    const id = own ?? `#${parent}/${siblingIndex}`;
    const entry: BlockEntry = {
      id,
      type: node.type.name,
      node,
      pos,
      parent,
      path,
      region,
      leaf: !CONTAINERS.has(node.type.name),
    };
    if (!index.blocks.has(id)) {
      index.blocks.set(id, entry);
      index.order.push(entry);
      childList(parent).push(id);
    }
    return entry;
  };

  /** Inline content of a leaf block: form fields and the paragraphs of footnotes. */
  const walkInline = (
    leaf: BlockEntry,
    node: Node,
    contentStart: number,
    region: string | null,
  ): void => {
    node.forEach((child, offset) => {
      const pos = contentStart + offset;
      if (child.type.name === 'form_field') {
        const id = idOf(child);
        if (id && !index.fields.has(id))
          index.fields.set(id, { id, node: child, pos, block: leaf.id, region });
      } else if (child.type.name === 'footnote') {
        const fid = idOf(child) ?? `#${leaf.id}/fn${offset}`;
        const path = [...leaf.path, leaf.id, fid];
        let i = 0;
        child.forEach((p, o) => {
          const entry = addBlock(p, pos + 1 + o, fid, path, region, i++);
          walkLeafOrContainer(entry, region);
        });
      } else if (!child.isLeaf) {
        // A wrapper without an identifier, such as a figure's caption.
        walkInline(leaf, child, pos + 1, region);
      }
    });
  };

  const walkLeafOrContainer = (entry: BlockEntry, region: string | null): void => {
    if (entry.leaf) {
      walkInline(entry, entry.node, entry.pos + 1, region);
      return;
    }
    const path = [...entry.path, entry.id];
    let i = 0;
    entry.node.forEach((child, offset) => {
      const c = addBlock(child, entry.pos + 1 + offset, entry.id, path, region, i++);
      walkLeafOrContainer(c, region);
    });
  };

  let top = 0;
  doc.forEach((child, offset) => {
    const pos = offset;
    if (child.type.name === 'defs') {
      child.forEach((d, o) => {
        const key = definitionKey(d);
        if (!index.definitions.has(key))
          index.definitions.set(key, {
            key,
            type: d.type.name,
            id: idOf(d) ?? '',
            node: d,
            pos: pos + 1 + o,
          });
      });
    } else if (child.type.name === 'story') {
      const entry = addBlock(child, pos, '#stories', [], null, top++);
      walkLeafOrContainer(entry, null);
    } else if (child.type.name === 'body') {
      let i = 0;
      child.forEach((block, o) => {
        const isRegion = block.type.name === 'region' || block.type.name === PLACEHOLDER;
        const region = isRegion ? idOf(block) : null;
        const entry = addBlock(block, pos + 1 + o, '#body', [], region, i++);
        walkLeafOrContainer(entry, region);
      });
    }
  });
  return index;
}

// -----------------------------------------------------------------------------------------------
// Inline content as tokens.

export type Granularity = 'word' | 'char';

export interface Token {
  /** What is compared: the text of a text token, or a key for an inline node. */
  key: string;
  /** The text shown for the token. */
  text: string;
  /** Offset in the leaf block's content (ProseMirror positions, so UTF-16 units for text). */
  off: number;
  /** Size in positions. */
  size: number;
  /** The marks of the token, as a signature; equal keys with different signatures are formatting. */
  marks: string;
  /** Mark type names on the token, for reporting formatting changes. */
  markNames: readonly string[];
}

/** The text shown for an inline node in a span (08 §6 spans carry text). */
function atomText(n: Node): string {
  switch (n.type.name) {
    case 'break':
      return '\n';
    case 'tab':
      return '\t';
    default:
      return '￼';
  }
}

/** What identifies an inline node when token lists are compared. */
function atomKey(n: Node): string {
  const id = idOf(n);
  switch (n.type.name) {
    case 'footnote':
    case 'anchor':
      return `${n.type.name}#${id ?? '?'}`;
    case 'form_field': {
      // The value is compared on its own, as a change of kind `field` (08 §6).
      const rest: Record<string, unknown> = { ...n.attrs };
      delete rest['value'];
      return `form_field#${id ?? '?'}|${stableJson(rest)}`;
    }
    default:
      return `${n.type.name}|${stableJson(n.attrs)}`;
  }
}

/** JSON with object keys sorted, so equal values give equal strings. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

function markSignature(marks: readonly Mark[]): string {
  return marks.map((m) => `${m.type.name}${stableJson(m.attrs)}`).join(';');
}

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const WORD = /[\p{L}\p{M}\p{N}_]/u;
const SPACE = /\s/u;

type CharClass = 'word' | 'space' | 'single';

function classOf(ch: string): CharClass {
  if (CJK.test(ch)) return 'single';
  if (WORD.test(ch)) return 'word';
  if (SPACE.test(ch)) return 'space';
  return 'single';
}

interface Piece {
  text: string;
  off: number;
  marks: readonly Mark[];
}

/**
 * The tokens of a leaf block's inline content. Words, runs of white space and single other
 * characters at `word` granularity (each Chinese, Japanese or Kana character is a word of its
 * own); code points at `char` granularity. A footnote is one token: its paragraphs are blocks.
 */
export function tokenize(leaf: Node, granularity: Granularity): Token[] {
  const tokens: Token[] = [];
  let run: Piece[] = [];
  const flush = () => {
    if (run.length) tokens.push(...textTokens(run, granularity));
    run = [];
  };
  const walk = (node: Node, start: number) => {
    node.forEach((child, offset) => {
      const off = start + offset;
      if (child.isText) run.push({ text: child.text ?? '', off, marks: child.marks });
      else if (child.isInline) {
        flush();
        tokens.push({
          key: atomKey(child),
          text: atomText(child),
          off,
          size: child.nodeSize,
          marks: markSignature(child.marks),
          markNames: child.marks.map((m) => m.type.name),
        });
      } else {
        flush();
        walk(child, off + 1);
      }
    });
  };
  walk(leaf, 0);
  flush();
  return tokens;
}

function textTokens(pieces: readonly Piece[], granularity: Granularity): Token[] {
  // Characters with their offsets and marks, across text nodes with different marks.
  const out: Token[] = [];
  let cur: {
    text: string;
    off: number;
    sigs: string[];
    names: Set<string>;
    cls: CharClass;
  } | null = null;
  const close = () => {
    if (!cur) return;
    out.push({
      key: cur.text,
      text: cur.text,
      off: cur.off,
      size: cur.text.length,
      marks: compressSigs(cur.sigs),
      markNames: [...cur.names].sort(),
    });
    cur = null;
  };
  for (const p of pieces) {
    const sig = markSignature(p.marks);
    let i = 0;
    for (const ch of p.text) {
      const off = p.off + i;
      i += ch.length;
      const cls = granularity === 'char' ? 'single' : classOf(ch);
      if (!cur || cls === 'single' || cls !== cur.cls) {
        close();
        cur = { text: '', off, sigs: [], names: new Set(), cls };
      }
      cur.text += ch;
      for (let k = 0; k < ch.length; k++) cur.sigs.push(sig);
      for (const m of p.marks) cur.names.add(m.type.name);
      if (cls === 'single') close();
    }
  }
  close();
  return out;
}

function compressSigs(sigs: readonly string[]): string {
  let out = '';
  let last: string | null = null;
  let n = 0;
  for (const s of sigs) {
    if (s === last) n++;
    else {
      if (last !== null) out += `${n}:${last}|`;
      last = s;
      n = 1;
    }
  }
  if (last !== null) out += `${n}:${last}`;
  return out;
}

/** The names of attributes that differ between two nodes, the identifier excepted. */
export function changedAttrs(a: Node, b: Node, except: readonly string[] = ['id']): string[] {
  const names = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
  const out: string[] = [];
  for (const k of names) {
    // Block suggestions (`suggest`) are read as marks by changedNodeMarks, as they were node marks.
    if (except.includes(k) || k === 'suggest') continue;
    if (stableJson(a.attrs[k]) !== stableJson(b.attrs[k])) out.push(k);
  }
  return out.sort();
}

/** The suggestions a node carries itself: its marks and the entries of its `suggest` attribute. */
function suggestionKeys(n: Node): Array<{ name: string; key: string }> {
  const out = n.marks.map((m) => ({
    name: m.type.name,
    key: `${m.type.name}${stableJson(m.attrs)}`,
  }));
  const s: unknown = n.attrs['suggest'];
  if (Array.isArray(s))
    for (const e of s as Array<{ type?: unknown; attrs?: unknown }>)
      if (typeof e?.type === 'string')
        out.push({ name: e.type, key: `${e.type}${stableJson(e.attrs)}` });
  return out;
}

/** Mark type names present on one node and not the other (marks, and block suggestions). */
export function changedNodeMarks(a: Node, b: Node): string[] {
  const ka = suggestionKeys(a);
  const kb = suggestionKeys(b);
  const sa = new Set(ka.map((m) => m.key));
  const sb = new Set(kb.map((m) => m.key));
  const names = new Set<string>();
  for (const m of ka) if (!sb.has(m.key)) names.add(m.name);
  for (const m of kb) if (!sa.has(m.key)) names.add(m.name);
  return [...names].sort();
}
