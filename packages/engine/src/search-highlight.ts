/**
 * The find highlights of the body (FE-059 criteria 1 and 4; 02 §5.2).
 *
 * The highlights are decorations computed from the document and the find state on every draw, so
 * a remote commit that adds, removes or moves a match changes the highlights in the same pass as
 * the counts (criterion 4). The document is never changed to draw them.
 *
 * The matches come from `findMatches` (search.ts), the same function the core counts with, so the
 * highlights and the "n of m" count cannot disagree. Only the body is highlighted, as the search
 * itself only searches the body (search.ts).
 *
 * This module imports `prosemirror-view` for `Decoration` only; it builds no DOM. The web view
 * passes `findDecorations` as its `decorations` prop (view/web.ts).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { findMatches } from './search.ts';

/** The class of every match except the current one. The element's style sheet names it. */
export const FIND_MATCH_CLASS = 'de-find-match';

/** The class of the current match (the one "n of m" names). */
export const FIND_CURRENT_CLASS = 'de-find-current';

/**
 * The part of the find state the highlights need: the query, and the current match counted from 1
 * (as `FindState.current` is), or null when no match is current.
 */
export interface FindHighlight {
  readonly query: string;
  readonly current: number | null;
}

/** The highlights of every body match of `find.query` in `doc`; none for an empty query. */
export function findDecorations(doc: PMNode, find: FindHighlight): DecorationSet {
  if (find.query === '') return DecorationSet.empty;
  const matches = findMatches(doc, find.query);
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i + 1 === find.current ? FIND_CURRENT_CLASS : FIND_MATCH_CLASS,
      }),
    ),
  );
}
