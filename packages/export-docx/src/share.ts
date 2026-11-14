/**
 * Shared residues (spike S11, model change 4; 03 §4.6): a preserved tree that occurs often enough
 * moves into one `preserved_def` in `defs`, and every occurrence becomes `{ "ref": id }`.
 *
 * Word repeats the same unmodelled properties on thousands of runs and paragraphs (S11: on a large
 * real file, 37,101 element trees held 964 distinct values), so without sharing a large document
 * exceeds the canonical size of I7. A tree is shared only when that makes the canonical document
 * smaller: n occurrences of a tree of L bytes cost n × L inline, and about 26 × n + 66 + L shared
 * (a reference is `{"ref":"<16 characters>"}`; the definition node carries the tree once).
 */
import { canonicalize, type JsonEnvelope, type JsonNode } from '@docedit/model';
import type { JsonValue } from '@docedit/model/definition';
import { isTreeRef } from './tree.ts';

interface Occurrence {
  holder: Record<string, JsonValue>;
  key: string;
}

interface Group {
  text: string;
  value: JsonValue;
  count: number;
  holders: Occurrence[];
  seen: Set<Record<string, JsonValue>>;
}

const REF_BYTES = 26;
const DEF_BYTES = 66;

/** Whether sharing a tree of `bytes` canonical bytes used `count` times makes the document smaller. */
export const worthSharing = (count: number, bytes: number): boolean =>
  (count - 1) * bytes > REF_BYTES * count + DEF_BYTES;

export interface ShareResult {
  defs: number;
  occurrences: number;
}

/**
 * Moves repeated trees into `preserved_def` nodes appended to `defs`. Trees are looked up in every
 * `preserved` attribute, every `preserved` mark's `props` and every `preserved_inline.tree`.
 */
export function shareTrees(env: JsonEnvelope, newId: () => string): ShareResult {
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  const visit = (holder: Record<string, JsonValue>, key: string): void => {
    const value = holder[key];
    if (value === null || value === undefined || isTreeRef(value)) return;
    const text = canonicalize(value);
    let g = groups.get(text);
    if (!g) {
      g = { text, value, count: 0, holders: [], seen: new Set() };
      groups.set(text, g);
      order.push(g);
    }
    // A mark object shared by several text nodes is counted once per node (each node carries its
    // marks in the canonical form) but replaced once.
    g.count++;
    if (!g.seen.has(holder)) {
      g.seen.add(holder);
      g.holders.push({ holder, key });
    }
  };
  const walk = (n: JsonNode): void => {
    const attrs = n.attrs as Record<string, JsonValue> | undefined;
    if (attrs && n.type !== 'preserved_def') {
      if (attrs['preserved'] !== undefined) visit(attrs, 'preserved');
      if (n.type === 'preserved_inline' && attrs['tree'] !== undefined) visit(attrs, 'tree');
    }
    for (const m of n.marks ?? [])
      if (m.type === 'preserved' && m.attrs) visit(m.attrs as Record<string, JsonValue>, 'props');
    for (const c of n.content ?? []) walk(c);
  };
  walk(env.doc);

  const defs = env.doc.content?.find((n) => n.type === 'defs');
  if (!defs) return { defs: 0, occurrences: 0 };
  let made = 0;
  let occurrences = 0;
  for (const g of order) {
    if (!worthSharing(g.count, g.text.length)) continue;
    const id = newId();
    (defs.content ??= []).push({ type: 'preserved_def', attrs: { id, tree: g.value } });
    for (const o of g.holders) o.holder[o.key] = { ref: id };
    made++;
    occurrences += g.count;
  }
  return { defs: made, occurrences };
}

/**
 * For every shared tree, the nearest identified nodes that refer to it, in document order and
 * without repeats. A reference in a text node's mark counts for the node that holds the text.
 */
export function treeHolders(env: JsonEnvelope): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const note = (value: JsonValue | undefined, holder: string | null): void => {
    if (holder === null || value === undefined || !isTreeRef(value)) return;
    const list = out.get(value.ref) ?? [];
    if (!list.includes(holder)) list.push(holder);
    out.set(value.ref, list);
  };
  const walk = (n: JsonNode, nearest: string | null): void => {
    const attrs = n.attrs as Record<string, JsonValue> | undefined;
    const own = typeof attrs?.['id'] === 'string' ? attrs['id'] : null;
    const holder = own ?? nearest;
    if (attrs && n.type !== 'preserved_def') {
      note(attrs['preserved'], holder);
      if (n.type === 'preserved_inline') note(attrs['tree'], holder);
    }
    for (const m of n.marks ?? [])
      if (m.type === 'preserved' && m.attrs)
        note((m.attrs as Record<string, JsonValue>)['props'], holder);
    for (const c of n.content ?? []) walk(c, holder);
  };
  walk(env.doc, null);
  return out;
}

/** The trees of a document's `preserved_def` nodes, by identifier. */
export function sharedTrees(env: JsonEnvelope): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  const defs = env.doc.content?.find((n) => n.type === 'defs');
  for (const d of defs?.content ?? [])
    if (d.type === 'preserved_def' && typeof d.attrs?.['id'] === 'string')
      out.set(d.attrs['id'], (d.attrs['tree'] ?? null) as JsonValue);
  return out;
}
