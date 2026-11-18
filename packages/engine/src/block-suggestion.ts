/**
 * Block suggestions as the document stores them (03 §5; CDM-040; owner decision 92). A paragraph, a
 * table row and a table keep their suggestions in the `suggest` attribute: an array of entries with
 * the shape of a suggestion mark, `{ type: 'ins' | 'del' | 'fmt', attrs: { id, user, before? } }`, or
 * null. They are not node marks, so `prosemirror-view` draws no element around the block and the
 * editing surface can show them as node decorations only (FE-044 criterion 4, FE-045 criterion 1).
 *
 * Text and inline nodes keep suggestion marks. `suggestionsOf` reads both, so that a reader of a
 * node's suggestions does not care where they are kept.
 *
 * Universal logic over ProseMirror nodes only: no Node.js or browser API.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

export type SuggestionKind = 'ins' | 'del' | 'fmt';

/** One suggestion on a node: a mark's type and attributes, or an entry of `suggest`. */
export interface SuggestionEntry {
  readonly type: SuggestionKind;
  readonly attrs: {
    readonly id: string;
    readonly user: string;
    readonly before?: unknown;
  };
}

const KINDS: readonly SuggestionKind[] = ['ins', 'del', 'fmt'];
const isKind = (v: unknown): v is SuggestionKind => KINDS.includes(v as SuggestionKind);

/** The block types that keep suggestions in the `suggest` attribute (03 §5). */
export const SUGGEST_HOSTS: ReadonlySet<string> = new Set(['paragraph', 'table_row', 'table']);

/** The entries of a block's `suggest` attribute; empty for any other node. */
export function blockEntries(node: PMNode): SuggestionEntry[] {
  if (!SUGGEST_HOSTS.has(node.type.name)) return [];
  const value: unknown = node.attrs['suggest'];
  if (!Array.isArray(value)) return [];
  const out: SuggestionEntry[] = [];
  for (const e of value as unknown[]) {
    if (e === null || typeof e !== 'object') continue;
    const { type, attrs } = e as { type?: unknown; attrs?: unknown };
    if (!isKind(type) || attrs === null || typeof attrs !== 'object') continue;
    out.push(e as SuggestionEntry);
  }
  return out;
}

/** The suggestion marks of a node as entries (text and inline nodes). */
export function markEntries(marks: readonly Mark[]): SuggestionEntry[] {
  const out: SuggestionEntry[] = [];
  for (const m of marks) {
    if (!isKind(m.type.name)) continue;
    out.push({
      type: m.type.name,
      attrs: {
        id: String(m.attrs['id']),
        user: String(m.attrs['user']),
        ...(m.attrs['before'] !== undefined && m.attrs['before'] !== null
          ? { before: m.attrs['before'] }
          : {}),
      },
    });
  }
  return out;
}

/** Every suggestion a node carries itself: its suggestion marks, and its block suggestions. */
export function suggestionsOf(node: PMNode): SuggestionEntry[] {
  return [...markEntries(node.marks), ...blockEntries(node)];
}

/** The entry that a suggestion mark's attributes describe. */
export function entry(
  type: SuggestionKind,
  id: string,
  user: string,
  before?: unknown,
): SuggestionEntry {
  return {
    type,
    attrs: { id, user, ...(before !== undefined && before !== null ? { before } : {}) },
  };
}

/** The canonical order of entries: by kind in schema order (`ins`, `del`, `fmt`), then as given. */
function ordered(entries: readonly SuggestionEntry[]): SuggestionEntry[] {
  return KINDS.flatMap((k) => entries.filter((e) => e.type === k));
}

/** The value of the attribute for these entries: null when there are none. */
export function suggestValue(entries: readonly SuggestionEntry[]): SuggestionEntry[] | null {
  return entries.length === 0 ? null : ordered(entries);
}

/** Sets the block suggestions of the node at `pos` (an attribute step; null when none are left). */
export function setBlockEntries(
  tr: Transaction,
  pos: number,
  entries: readonly SuggestionEntry[],
): Transaction {
  return tr.setNodeAttribute(pos, 'suggest', suggestValue(entries));
}

/** Adds one block suggestion to the node at `pos`. */
export function addBlockEntry(tr: Transaction, pos: number, add: SuggestionEntry): Transaction {
  const node = tr.doc.nodeAt(pos);
  return setBlockEntries(tr, pos, [...(node ? blockEntries(node) : []), add]);
}

/** A copy of a node that carries one more block suggestion (a new block that is not in a document yet). */
export function withEntry(node: PMNode, add: SuggestionEntry): PMNode {
  return node.type.create(
    { ...node.attrs, suggest: suggestValue([...blockEntries(node), add]) },
    node.content,
    node.marks,
  );
}

/** Whether a node carries a suggestion of this kind by this user (a block suggestion, or a mark). */
export function hasOwn(node: PMNode, type: SuggestionKind, user: string): boolean {
  return suggestionsOf(node).some((e) => e.type === type && e.attrs.user === user);
}

/** Whether a node carries a suggestion of this kind by anyone. */
export function hasKind(node: PMNode, type: SuggestionKind): boolean {
  return suggestionsOf(node).some((e) => e.type === type);
}
