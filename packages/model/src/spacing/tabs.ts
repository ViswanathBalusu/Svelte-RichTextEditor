/**
 * Tab stops (03 §4.5, §7, "Tabs"; CDM-044). Positions are twips from the left margin. A tab moves
 * to the nearest stop strictly to the right of the current position among:
 *
 * - the paragraph's stops, from the cascade (the last layer that sets `tabs` gives the whole list);
 * - with a hanging indent (`indentFirstLine` below 0), the left indent, as a left stop with no
 *   leader, as Word does for the text after a list label;
 * - the multiples of `settings.defaultTabStop`, measured from the left margin, beyond the last of
 *   the paragraph's stops (explicit stops clear the default stops to their left).
 *
 * A numbering label is followed by such a tab. The text after a tab, up to the next tab, line
 * break or paragraph end, is the tab's segment: a left stop starts it at the stop, a right stop
 * ends it there, a centre stop centres it there and a decimal stop puts its first decimal
 * separator there (the end of the segment when it has none). A segment that does not fit before
 * the stop starts at the current position instead. The leader fills the space the tab spans.
 * Right-to-left paragraphs are an open question (ADR 0032); they are measured the same way here.
 */
import type { TabAlignment, TabLeader, TabStop } from '../cascade/resolve.ts';

export interface TabContext {
  /** The paragraph's stops in position order (`ParagraphProperties.tabs`). */
  readonly tabs: readonly TabStop[];
  readonly indentLeft: number;
  readonly indentFirstLine: number;
  /** `settings.defaultTabStop`, in twips. */
  readonly defaultTabStop: number;
}

export interface ResolvedTab {
  /** Twips from the left margin. */
  readonly position: number;
  readonly align: TabAlignment;
  readonly leader: TabLeader;
  readonly source: 'stop' | 'hanging' | 'default';
}

/**
 * The stop a tab at position `x` (twips from the left margin) moves to: the nearest of the first
 * explicit stop to the right of `x`, the hanging-indent stop, and the first default stop to the
 * right of both `x` and the last explicit stop (explicit stops clear the default stops to their
 * left; the hanging-indent stop does not). At one position an explicit stop wins over the
 * hanging-indent stop, and that over a default stop.
 */
export function nextTabStop(context: TabContext, x: number): ResolvedTab {
  const step = context.defaultTabStop;
  if (!Number.isSafeInteger(step) || step < 1)
    throw new RangeError(
      `nextTabStop: the default tab stop must be a positive number of twips, got ${step}`,
    );
  let best: ResolvedTab | null = null;
  for (const t of context.tabs)
    if (t.position > x) {
      best = { position: t.position, align: t.align, leader: t.leader, source: 'stop' };
      break;
    }
  if (
    context.indentFirstLine < 0 &&
    context.indentLeft > x &&
    (!best || context.indentLeft < best.position)
  )
    best = { position: context.indentLeft, align: 'left', leader: 'none', source: 'hanging' };
  const last = context.tabs.length ? context.tabs[context.tabs.length - 1]!.position : x;
  // The next multiple strictly to the right, also left of the margin (a negative indent).
  const position = (Math.floor(Math.max(x, last) / step) + 1) * step;
  if (best && best.position <= position) return best;
  return { position, align: 'left', leader: 'none', source: 'default' };
}

export interface TabSegment {
  /** The width of the segment after the tab, in twips. */
  readonly width: number;
  /** For a decimal stop: the width of the segment before its first decimal separator. */
  readonly beforeDecimal?: number | undefined;
}

export interface PlacedTab extends ResolvedTab {
  /** Where the segment after the tab starts, in twips from the left margin. */
  readonly start: number;
  /** The span the leader fills: from the current position to `start`. */
  readonly leaderFrom: number;
}

/** Places the segment that follows a tab at `x`. */
export function placeTab(context: TabContext, x: number, segment: TabSegment): PlacedTab {
  const tab = nextTabStop(context, x);
  let start: number;
  switch (tab.align) {
    case 'right':
      start = tab.position - segment.width;
      break;
    case 'center':
      start = tab.position - Math.floor(segment.width / 2);
      break;
    case 'decimal':
      start = tab.position - (segment.beforeDecimal ?? segment.width);
      break;
    default:
      start = tab.position;
  }
  return { ...tab, start: Math.max(x, start), leaderFrom: x };
}

/**
 * Where a decimal tab aligns a segment: the index of its first decimal separator, or the length of
 * the text when it has none. The separator is a full stop in version 1 (ADR 0032, open question).
 */
export function decimalIndex(text: string, separator = '.'): number {
  const i = text.indexOf(separator);
  return i < 0 ? text.length : i;
}
