/**
 * The suggestions of a document as a list (UX-036, UX-037; 02 §5.2; 03 §5). Each suggestion mark
 * (`ins`, `del`, `fmt`) has an identifier; the marks that share one are one suggestion, which may
 * span several runs of text, and a mark on a block is a block suggestion. The list is read from the
 * document and held nowhere: the review tools and the review pane ask for it after every change.
 *
 * Universal logic over ProseMirror nodes only: no Node.js or browser API.
 */
import type { Node as PMNode } from 'prosemirror-model';

export type SuggestionKind = 'ins' | 'del' | 'fmt';

/** One suggestion as it stands in the document. Positions are document positions. */
export interface SuggestionEntry {
  readonly id: string;
  readonly kind: SuggestionKind;
  /** True when the mark is on a block (a paragraph, a table row or a table), not on text. */
  readonly block: boolean;
  /** The author, `user` on the mark. */
  readonly user: string;
  /** First position of the suggestion, and the end of its last run. */
  readonly from: number;
  readonly to: number;
  /** The words the suggestion covers, cut to `EXCERPT_LENGTH`; empty for a block with no text. */
  readonly text: string;
}

/** A suggestion with what the user holds in its scope (the core adds `caps`). */
export interface SuggestionItem extends SuggestionEntry {
  /** The capabilities the user has in the suggestion's scope: `view`, `comment`, `suggest`, `edit`... */
  readonly caps: readonly string[];
  /** Whether the user may accept or reject it now: `edit` in its scope and the document not locked (P4). */
  readonly canResolve: boolean;
}

/** The longest excerpt kept: a suggestion's words, with an ellipsis when they are cut. */
export const EXCERPT_LENGTH = 80;

const KINDS: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

/**
 * The suggestions of `doc`, in document order (by first position, then by identifier). Marks with
 * no identifier are listed under the empty identifier and are not addressable.
 */
export function listSuggestions(doc: PMNode): SuggestionEntry[] {
  const found = new Map<
    string,
    { kind: SuggestionKind; block: boolean; user: string; from: number; to: number; text: string }
  >();
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (!KINDS.has(mark.type.name)) continue;
      const id = String(mark.attrs['id'] ?? '');
      const from = pos;
      const to = pos + node.nodeSize;
      const entry = found.get(id);
      if (entry === undefined) {
        found.set(id, {
          kind: mark.type.name as SuggestionKind,
          block: node.isBlock,
          user: String(mark.attrs['user'] ?? ''),
          from,
          to,
          text: node.isText ? (node.text ?? '') : '',
        });
      } else {
        entry.from = Math.min(entry.from, from);
        entry.to = Math.max(entry.to, to);
        if (node.isText) entry.text += node.text ?? '';
      }
    }
    return true;
  });
  return [...found.entries()]
    .map(([id, e]) => ({
      id,
      kind: e.kind,
      block: e.block,
      user: e.user,
      from: e.from,
      to: e.to,
      text: e.text.length > EXCERPT_LENGTH ? `${e.text.slice(0, EXCERPT_LENGTH)}…` : e.text,
    }))
    .sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
