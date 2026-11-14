/**
 * Which toolbar controls fit in one row (UX-006: "the commands that do not fit stay reachable").
 * The rest go to the overflow menu, in order, so none is lost.
 */

/**
 * The number of leading items that fit in `available` pixels. When not all fit, room is kept for
 * the overflow button. Unknown sizes (zero or negative) show everything: nothing is hidden on a
 * guess.
 */
export function fittingItems(
  widths: readonly number[],
  available: number,
  gap: number,
  overflowWidth: number,
): number {
  const n = widths.length;
  if (n === 0) return 0;
  if (!(available > 0) || widths.some((w) => !(w > 0))) return n;
  let total = 0;
  for (let i = 0; i < n; i++) total += widths[i]! + (i > 0 ? gap : 0);
  if (total <= available) return n;
  const room = available - overflowWidth - gap;
  let used = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const next = used + widths[i]! + (i > 0 ? gap : 0);
    if (next > room) break;
    used = next;
    count++;
  }
  return count;
}

/** The next index in a roving set of `count` items, wrapping (WAI-ARIA toolbar pattern). */
export function nextIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  return (((current + step) % count) + count) % count;
}
