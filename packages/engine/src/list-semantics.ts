/**
 * ARIA list semantics for numbered and bulleted paragraphs (02 §10; 03 §4.3; FE-105).
 *
 * The model has no list nodes: a paragraph carries `numbering` with a `listId` and a `level`
 * (CDM-042). A list is a run of consecutive paragraphs with the same `listId`. For each paragraph
 * this module returns the ARIA attributes a `listitem` needs: its nesting level and its position
 * and size among its siblings.
 *
 * Siblings of an item are the items at the same level in the same parent segment: the segment is
 * the stretch around the item where no item has a lower level (a sub-list sits inside its parent
 * item's segment). Positions count from 1, in document order.
 *
 * Pure: no DOM. The web view applies the result to its paragraphs as node decorations
 * (view/list-view.ts). The web view passes it, once per `listId`, the items of that list across the
 * whole body in document order, so a list that continues across regions, tables and items of other
 * lists is one run, as the computed label counts it (FE-105 criterion 4).
 */

/** A paragraph as the list rules see it: its list and its level (0 to 8, CDM-042). */
export interface ListParagraph {
  readonly listId: string;
  readonly level: number;
  /**
   * The paragraph sets its level's counter (`numberingRestart`, 03 §7): it starts a new set of
   * siblings at its level, as a new `<ol start>` would. A reading taken here (FE-105 notes).
   */
  readonly restart?: boolean;
}

/** The attributes a `listitem` carries. `null` for a paragraph that is not in a list. */
export interface ListItemSemantics {
  readonly role: 'listitem';
  /** Nesting depth, 1 at the top level (`level + 1`). */
  readonly 'aria-level': number;
  /** Position among the siblings, from 1. */
  readonly 'aria-posinset': number;
  /** Number of siblings, including this one. */
  readonly 'aria-setsize': number;
}

/**
 * The list semantics of each paragraph, in the same order. A paragraph is in a list when its
 * `listId` is non-empty; a paragraph with an empty `listId` gets `null` and breaks the runs around
 * it.
 *
 * Cost: linear in the run lengths times the depth of nesting; a run of n items at one level is
 * O(n²) in the worst case. The measurement of very long lists is not made here (FE-089, FE-118).
 */
export function listSemantics(paragraphs: readonly ListParagraph[]): (ListItemSemantics | null)[] {
  const out: (ListItemSemantics | null)[] = new Array<ListItemSemantics | null>(paragraphs.length);
  let start = 0;
  while (start < paragraphs.length) {
    const first = paragraphs[start];
    if (!first || first.listId === '') {
      out[start] = null;
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < paragraphs.length && paragraphs[end]?.listId === first.listId) end += 1;
    for (let i = start; i < end; i += 1) out[i] = itemIn(paragraphs, start, end, i);
    start = end;
  }
  return out;
}

/** Semantics of the item at `i` in the run `[start, end)`. */
function itemIn(
  paragraphs: readonly ListParagraph[],
  start: number,
  end: number,
  i: number,
): ListItemSemantics {
  const level = paragraphs[i]?.level ?? 0;
  // The parent segment: back to the last item of a lower level, forward to the next one. A
  // restart at this level also bounds it: the set begins at the restarting item.
  const restartsHere = (j: number): boolean =>
    paragraphs[j]?.restart === true && (paragraphs[j]?.level ?? 0) === level;
  let lo = i;
  while (lo > start && !restartsHere(lo) && (paragraphs[lo - 1]?.level ?? 0) >= level) lo -= 1;
  let hi = i + 1;
  while (hi < end && !restartsHere(hi) && (paragraphs[hi]?.level ?? 0) >= level) hi += 1;
  let position = 0;
  let size = 0;
  for (let j = lo; j < hi; j += 1) {
    if ((paragraphs[j]?.level ?? 0) !== level) continue;
    size += 1;
    if (j <= i) position += 1;
  }
  return {
    role: 'listitem',
    'aria-level': level + 1,
    'aria-posinset': position,
    'aria-setsize': size,
  };
}
