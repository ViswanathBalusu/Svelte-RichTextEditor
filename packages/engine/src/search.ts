/**
 * Find and replace in the body (02 §5.2; FE-059, FE-060). The matcher is plain and case-sensitive:
 * the match options of FE-059 (case, whole word) and whether headers, footers and footnotes are
 * searched are open (the story's Notes; ADR 0108). Only the body is searched.
 *
 * Every scope of the body is searched, including regions the user may not change: finding is never
 * refused (FE-059 criterion 5). Only replacing is checked against the region guard (core.ts).
 *
 * A match may span text with different marks (FE-059 criterion 3): the paragraph's text is read
 * as one string, and each character keeps the document position it came from. An inline node that
 * is not text (a field, a placeholder) counts as one character no plain query matches, so a match
 * never spans it.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { regionAt } from './regions.ts';

/** One match, with the document positions the core keeps; the public shape omits them. */
export interface SearchMatch {
  readonly from: number;
  readonly to: number;
  /** The identifier of the paragraph the match is in, or null. */
  readonly blockId: string | null;
  /** The DEP scope of the match: `body` or `region:<id>` (05 §5.3). */
  readonly scope: string;
  /** Up to `CONTEXT` characters before the match, in the same paragraph. */
  readonly before: string;
  readonly text: string;
  /** Up to `CONTEXT` characters after the match, in the same paragraph. */
  readonly after: string;
}

/** The characters of context shown with a match in a navigation pane. */
export const CONTEXT = 40;

/** Stands for an inline node that is not text; no plain query contains it. */
const OBJECT = '￼';

/** The match options a caller may give (UX-020: the navigation pane's "match case"). */
export interface FindOptions {
  /** Whether case matters; true (the proposed default of ADR 0108) when absent. */
  readonly matchCase?: boolean;
}

/**
 * Lower-cases a text one UTF-16 unit at a time and keeps a unit whose lower case has another length,
 * so that the folded text has the length of the original and its indices are the same.
 */
function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text[i]!;
    const lower = unit.toLowerCase();
    out += lower.length === 1 ? lower : unit;
  }
  return out;
}

/**
 * Finds every non-overlapping match of `query` in the body, in document order. Case matters unless
 * `options.matchCase` is false; the matched text, the context and the positions are the document's.
 */
export function findMatches(doc: PMNode, query: string, options?: FindOptions): SearchMatch[] {
  if (query === '') return [];
  const fold_ = options?.matchCase === false;
  const needle = fold_ ? fold(query) : query;
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return [];
  const bodyStart = doc.content.size - body.nodeSize;
  const out: SearchMatch[] = [];
  doc.nodesBetween(bodyStart, doc.content.size, (node, pos) => {
    // Footnotes have their own paragraphs; they are not part of the body's text (open question).
    if (node.type.name === 'footnote') return false;
    if (!node.isTextblock) return true;
    const { text, positions } = paragraphText(node, pos + 1);
    const haystack = fold_ ? fold(text) : text;
    let i = haystack.indexOf(needle);
    while (i !== -1) {
      const matched = text.slice(i, i + query.length);
      if (!matched.includes(OBJECT)) {
        const from = positions[i]!;
        const to = positions[i + query.length - 1]! + 1;
        const scope = regionAt(doc.resolve(from));
        out.push({
          from,
          to,
          blockId: typeof node.attrs['id'] === 'string' ? node.attrs['id'] : null,
          scope: scope ? `region:${scope.id ?? ''}` : 'body',
          before: text.slice(Math.max(0, i - CONTEXT), i).replaceAll(OBJECT, ''),
          text: matched,
          after: text.slice(i + query.length, i + query.length + CONTEXT).replaceAll(OBJECT, ''),
        });
      }
      i = haystack.indexOf(needle, i + query.length);
    }
    return false;
  });
  return out;
}

/** The text of a paragraph, with the document position of each of its characters. */
function paragraphText(node: PMNode, start: number): { text: string; positions: number[] } {
  let text = '';
  const positions: number[] = [];
  node.forEach((child, offset) => {
    const at = start + offset;
    if (child.isText) {
      const s = child.text ?? '';
      for (let k = 0; k < s.length; k++) {
        positions.push(at + k);
      }
      text += s;
    } else {
      text += OBJECT;
      positions.push(at);
    }
  });
  return { text, positions };
}
