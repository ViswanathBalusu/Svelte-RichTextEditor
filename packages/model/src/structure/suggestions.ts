/**
 * Suggestions as the document records them (03 §5; CDM-039, CDM-040): `ins`, `del` and `fmt` marks
 * on text, and the same marks as node marks on paragraphs, table rows and tables. One suggestion
 * identifier can span many runs; this reader groups them. It reads the data only: accepting,
 * rejecting and the time of a suggestion (the server time of the commit that introduced its
 * identifier) are FE's and HIS's.
 */
import type { JsonMark, JsonNode } from '../canonical/canonical-form.ts';
import type { JsonValue } from '../definition/grammar.ts';

export type SuggestionKind = 'insert' | 'delete' | 'format';

export interface SuggestionPart {
  /** `text` for a run of text, otherwise the node type of a block suggestion. */
  on: string;
  /** The identifier of the block, or of the block that holds the text. */
  blockId: string | null;
  /** The text of a run; null for a block. */
  text: string | null;
}

export interface Suggestion {
  id: string;
  user: string;
  kind: SuggestionKind;
  /** For `format`: the previous marks of text, or the previous style, alignment or list level of a block. */
  before: { marks?: JsonValue; attrs?: JsonValue } | null;
  parts: SuggestionPart[];
}

const KINDS: Readonly<Record<string, SuggestionKind>> = {
  ins: 'insert',
  del: 'delete',
  fmt: 'format',
};

/** Every suggestion of a document or subtree, in order of first appearance. */
export function suggestionsOf(root: JsonNode): Suggestion[] {
  const out = new Map<string, Suggestion>();
  const note = (mark: JsonMark, part: SuggestionPart) => {
    if (!Object.hasOwn(KINDS, mark.type)) return;
    const id = mark.attrs?.['id'];
    const user = mark.attrs?.['user'];
    if (typeof id !== 'string' || typeof user !== 'string') return;
    const key = `${mark.type}\u0000${id}`;
    let s = out.get(key);
    if (!s) {
      const before = mark.attrs?.['before'];
      s = {
        id,
        user,
        kind: KINDS[mark.type]!,
        before:
          mark.type === 'fmt' && before && typeof before === 'object' && !Array.isArray(before)
            ? { ...before }
            : null,
        parts: [],
      };
      out.set(key, s);
    }
    s.parts.push(part);
  };
  const visit = (node: JsonNode, blockId: string | null) => {
    const own = typeof node.attrs?.['id'] === 'string' ? (node.attrs['id'] as string) : blockId;
    if (node.type === 'text') {
      for (const m of node.marks ?? []) note(m, { on: 'text', blockId, text: node.text ?? '' });
      return;
    }
    for (const m of node.marks ?? []) note(m, { on: node.type, blockId: own, text: null });
    for (const c of node.content ?? []) visit(c, own);
  };
  visit(root, null);
  return [...out.values()];
}
