/**
 * The read-only pages' status line (02 §7; FE-095 criterion 3). The status bar asks the engine for
 * the page count, and the engine says whether that count is final. The count is final when the
 * page passes settled and every block has been placed. A table that is not placed yet (FE-083) can
 * change the page count, so the count is then provisional. The rule is a proposed default recorded in
 * docs/adr/0135-layout-2-backlog-batch.md (item 9).
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type { LayoutResult } from './engine.ts';

export interface PageStatus {
  /** The number of pages in the layout tree. */
  readonly pages: number;
  /** True when no later pass can change the count (see the module comment). */
  readonly final: boolean;
  /** Why the count is provisional, one reason per line; empty when it is final. */
  readonly reasons: readonly string[];
}

/** The page count of a layout result and whether it is final (FE-095 criterion 3). */
export function pageStatus(result: LayoutResult): PageStatus {
  const reasons: string[] = [];
  if (!result.pageCountSettled)
    reasons.push('the page passes did not settle, so the count may change');
  if (result.unplaced.length > 0)
    reasons.push(
      `${result.unplaced.length} block${result.unplaced.length === 1 ? ' is' : 's are'} not placed yet (tables, FE-083)`,
    );
  return Object.freeze({
    pages: result.tree.pages.length,
    final: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}
