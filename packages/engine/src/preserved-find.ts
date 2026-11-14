/**
 * Find and replace and preserved content (FE-139 criterion 4; 03 §4.6; ADR 0017 part 3).
 *
 * The XML of a `preserved_block` or `preserved_inline` is never text the editor reads, and the
 * editor never renders it (FE-139 criterion 6). Its fallback text is an attribute, not text content,
 * so `findMatches` (search.ts) does not match inside it. An inline preserved atom holds one object
 * character, which `findMatches` already refuses to match.
 *
 * This module counts the preserved atoms that a search skipped: those in the body whose fallback
 * text holds the query, that is, the atoms a reader would expect the search to find. The count is
 * the report criterion 4 asks for; the find panel that shows it is the view's and is not built.
 */
import type { Node as PMNode } from 'prosemirror-model';

/** The node types whose content is preserved and never searched (03 §4.6). */
export const PRESERVED_TYPES: ReadonlySet<string> = new Set([
  'preserved_block',
  'preserved_inline',
]);

/**
 * The number of preserved atoms in the body whose fallback text contains `query` (case-sensitive,
 * as `findMatches` compares). Footnotes are outside the body's text, as in `findMatches`. An empty
 * query skips nothing.
 */
export function skippedPreservedAtoms(doc: PMNode, query: string): number {
  if (query === '') return 0;
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return 0;
  const bodyStart = doc.content.size - body.nodeSize;
  let skipped = 0;
  doc.nodesBetween(bodyStart, doc.content.size, (node) => {
    if (node.type.name === 'footnote') return false;
    if (PRESERVED_TYPES.has(node.type.name)) {
      const fallback = node.attrs['fallbackText'];
      if (typeof fallback === 'string' && fallback.includes(query)) skipped++;
      return false;
    }
    return true;
  });
  return skipped;
}
