/**
 * Line heights (03 §7, "Line spacing"; CDM-043). Under `multiple`, `lineSpacing` is in thousandths
 * and applies per line to the height of the tallest run on that line, not to a paragraph-wide
 * value; under `exact` and `atLeast` it is a length in twips.
 *
 * A run's height is its natural single-spaced height: the font's line height at the run's size,
 * which the layout engine measures (02 §9.3) and the LaTeX class reads from the same font files.
 * An inline picture or other inline box counts as a run of its own height. An empty line (an empty
 * paragraph, or a line holding only a line break) has the height of the paragraph mark, that is of
 * the paragraph's own run properties. How the extra space of a `multiple` line is split above and
 * below the text is not fixed here (ADR 0032, open question).
 */
import type { LineRule } from '../cascade/resolve.ts';

export interface LineSpacing {
  readonly lineSpacing: number;
  readonly lineRule: LineRule;
}

/**
 * The height of one line in twips. `runHeights` holds the natural height of every run and inline
 * box on the line, in twips; at least one is required. `multiple` rounds half up to whole twips.
 */
export function lineHeight(spacing: LineSpacing, runHeights: readonly number[]): number {
  if (runHeights.length === 0)
    throw new RangeError('lineHeight: a line has at least one run (the paragraph mark when empty)');
  let tallest = 0;
  for (const h of runHeights) {
    if (!Number.isSafeInteger(h) || h < 0)
      throw new RangeError(`lineHeight: run heights are whole twips, got ${h}`);
    if (h > tallest) tallest = h;
  }
  switch (spacing.lineRule) {
    case 'exact':
      return spacing.lineSpacing;
    case 'atLeast':
      return Math.max(spacing.lineSpacing, tallest);
    default:
      return Math.floor((spacing.lineSpacing * tallest + 500) / 1000);
  }
}
