/**
 * Greedy first-fit line breaking for one paragraph (02 §9.3; FE-081), and the `LineBreaker` provider
 * interface it implements (FE-076): the engine takes its breaker as an injected provider, and
 * `firstFitBreaker` is the default a caller passes. The breaker never measures
 * text by itself and never looks for break opportunities by itself: both come in through the
 * injected `TextMeasurer` (measure.ts) and `BreakOpportunities` (FE-080, not yet built). Its output
 * is the layout tree's paragraph fragment (tree.ts), so the painter and hit testing see the same
 * shape the spike adapters produce.
 *
 * Rules implemented here:
 * - a line ends only at a break opportunity or at the end of its forced-break segment (FE-081);
 * - each line takes as many opportunities as fit, measured without its trailing spaces (first fit);
 * - no word is hyphenated: the `hyphenation` setting admits only `false` (the default);
 * - the first line uses `indentLeft + indentFirstLine` as its start, and a negative first-line
 *   indent makes a hanging indent; `indentRight` narrows every line;
 * - a line's height follows its tallest run under the `multiple` rule (the largest natural height of
 *   its fonts, times the factor); `exact` and `atLeast` use points;
 * - a newline character (U+000A) is a forced break: the line ends after it and the character has no
 *   width;
 * - a tab character (U+0009) moves to the next tab stop in column coordinates, or to the next default
 *   stop when `defaultTabStop` is set; the text after it is aligned by the stop (left, centre, right
 *   or decimal, FE-081 criterion 3); a trailing tab does not count towards the fit.
 *
 * Open point, recorded in docs/adr/0120-layout-backlog-batch.md: a single unbreakable word wider
 * than the line is placed alone on its line and overflows it. The spec does not say what happens.
 *
 * Offsets are UTF-16 code units inside the paragraph's text. The caller maps them to CDM offsets.
 * Lengths are in points. Universal: no DOM and no Node.js API (FND-004).
 */
import type { FontKey, LineMetrics, TextMeasurer } from './measure.ts';
import { freezeTree, type LayoutLine, type ParagraphFragment } from './tree.ts';

/** A run of text set in one font. Runs are concatenated in order to form the paragraph's text. */
export interface BreakRun {
  readonly text: string;
  readonly font: FontKey;
}

/**
 * Break opportunities of a text (FE-080's provider interface): offsets in UTF-16 code units at which
 * a line may end, in ascending order and each in (0, text.length]. The engine accepts any
 * implementation that returns such offsets; the Unicode line breaking algorithm will be one.
 *
 * `language` is the BCP 47 tag of the text when the paragraph has one (the `lang` of its style, or
 * the document's default). It is absent otherwise. An implementation may ignore it (FE-080
 * criterion 3: the provider interface takes text and language in).
 */
export interface BreakOpportunities {
  opportunities(text: string, language?: string): readonly number[];
}

export type LineSpacing =
  | { readonly rule: 'multiple'; readonly factor: number }
  | { readonly rule: 'exact' | 'atLeast'; readonly pt: number };

/** How a tab stop aligns the text after the tab (FE-081 criterion 3; the model's `TabAlignment`). */
export type LineTabAlign = 'left' | 'center' | 'right' | 'decimal';

/** A tab stop: a bare number is a left stop, in points. */
export type LineTabStop = number | { readonly position: number; readonly align: LineTabAlign };

export interface ParagraphInput {
  /** The CDM block identifier the fragment records (FE-078). */
  readonly blockId: string;
  readonly runs: readonly BreakRun[];
  /** The paragraph mark's font: the line height of an empty paragraph. */
  readonly markFont: FontKey;
  /** The width of the text column, before the paragraph's own indents. */
  readonly columnWidth: number;
  /** Defaults to 0. */
  readonly indentLeft?: number;
  /** Defaults to 0. */
  readonly indentRight?: number;
  /** Defaults to 0. A negative value is a hanging indent. */
  readonly indentFirstLine?: number;
  readonly line: LineSpacing;
  /** Hyphenation is off by default. Turning it on is not specified, so the type admits only `false`. */
  readonly hyphenation?: false;
  /**
   * Tab stops, in points from the column's left edge (the same origin as `line.x`). Defaults to
   * none. A tab character moves to the nearest stop past the current position, and the text after it
   * (up to the next tab or the end of the span) is placed by the stop's alignment: left at the stop,
   * right ending at it, centre centred on it, and decimal with its first full stop on it (the end of
   * the text when it has none). A segment wider than the space left starts at the current position.
   * Leaders fill space and do not change widths, so they are not carried here.
   */
  readonly tabStops?: readonly LineTabStop[];
  /**
   * The spacing of default tab stops, in points, used for a tab past the last custom stop. Defaults
   * to 0, which means no default stops: such a tab then has no width. The spec gives no value.
   */
  readonly defaultTabStop?: number;
  /** The BCP 47 tag of the paragraph's text, passed to the break opportunities (FE-080). */
  readonly language?: string;
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly font: FontKey;
}

const SPACE = 0x20;
const NEWLINE = 0x0a;
const TAB = 0x09;

interface NormalisedStop {
  readonly position: number;
  readonly align: LineTabAlign;
}

function normaliseStop(t: LineTabStop): NormalisedStop {
  if (typeof t === 'number') return { position: t, align: 'left' };
  return { position: t.position, align: t.align };
}

/**
 * A line breaker (FE-076's third provider): breaks one paragraph into lines, with the measurer and
 * the break opportunities the engine was given. Its input (`ParagraphInput`) and output (a paragraph
 * fragment whose offsets are UTF-16 code units of the paragraph's text) are plain data. The engine
 * accepts any implementation that returns lines covering the text in order; `firstFitBreaker` is
 * this package's own.
 */
export interface LineBreaker {
  /** A name for the breaker, for example `first-fit`. */
  readonly id: string;
  breakParagraph(
    input: ParagraphInput,
    measurer: TextMeasurer,
    breaks: BreakOpportunities,
  ): ParagraphFragment;
}

function isTrailing(code: number): boolean {
  return code === SPACE || code === NEWLINE || code === TAB;
}

/**
 * Breaks one paragraph into lines. Pure: the same input and providers give the same fragment (FE-081
 * criterion 6). The result is frozen (FE-078).
 */
export function breakParagraph(
  input: ParagraphInput,
  measurer: TextMeasurer,
  breaks: BreakOpportunities,
): ParagraphFragment {
  const text = input.runs.map((r) => r.text).join('');
  const n = text.length;
  const indentLeft = input.indentLeft ?? 0;
  const indentRight = input.indentRight ?? 0;
  const indentFirst = input.indentFirstLine ?? 0;

  const segments: Segment[] = [];
  let offset = 0;
  for (const run of input.runs) {
    if (run.text.length === 0) continue;
    segments.push({ start: offset, end: offset + run.text.length, font: run.font });
    offset += run.text.length;
  }

  const fontAt = (pos: number): FontKey => {
    for (const s of segments) if (pos >= s.start && pos < s.end) return s.font;
    return input.markFont;
  };

  // Width of text[a, b) in the fonts of the runs it crosses. Runs are measured separately, so a
  // kerning pair across a run boundary is not counted (none is applied by the stub measurers).
  const spanWidth = (a: number, b: number): number => {
    if (b <= a) return 0;
    let w = 0;
    for (const s of segments) {
      if (s.end <= a || s.start >= b) continue;
      const lo = Math.max(a, s.start);
      const hi = Math.min(b, s.end);
      w += measurer.advance(s.font, text.slice(lo, hi));
    }
    return w;
  };

  const stops = (input.tabStops ?? []).map(normaliseStop).sort((u, v) => u.position - v.position);
  const step = input.defaultTabStop ?? 0;
  if (!Number.isFinite(step) || step < 0) throw new RangeError('defaultTabStop must be >= 0');
  // The next tab stop past p, in column coordinates (FE-081). With no stop left, the default
  // spacing gives a left stop; with neither, the stop is at p itself.
  const nextStop = (p: number): NormalisedStop => {
    for (const s of stops) if (s.position > p) return s;
    if (step > 0) return { position: (Math.floor(p / step) + 1) * step, align: 'left' };
    return { position: p, align: 'left' };
  };

  // The position where the text after a tab, text[segStart, segEnd), starts when the tab at p moves
  // to its stop (FE-081 criterion 3, as the model's `placeTab`): the stop aligns the text, and a
  // text wider than the space left starts at p.
  const placeAfterTab = (p: number, segStart: number, segEnd: number): number => {
    const stop = nextStop(p);
    let start = stop.position;
    if (stop.align === 'right') start = stop.position - spanWidth(segStart, segEnd);
    // The half-width is rounded down to whole twips (1/20 pt), as the model's `placeTab` does (CDM-044).
    else if (stop.align === 'center')
      start = stop.position - Math.floor(spanWidth(segStart, segEnd) * 10) / 20;
    else if (stop.align === 'decimal') {
      const dot = text.indexOf('.', segStart);
      const at = dot < 0 || dot >= segEnd ? segEnd : dot;
      start = stop.position - spanWidth(segStart, at);
    }
    return Math.max(p, start);
  };

  // The position reached from `start` after text[a, b), with tabs placing the text after them.
  const advanceFrom = (start: number, a: number, b: number): number => {
    let p = start;
    let cursor = a;
    for (let i = a; i < b; i++) {
      if (text.charCodeAt(i) !== TAB) continue;
      p += spanWidth(cursor, i);
      let end = i + 1;
      while (end < b && text.charCodeAt(end) !== TAB) end++;
      p = placeAfterTab(p, i + 1, end);
      cursor = i + 1;
    }
    return p + spanWidth(cursor, b);
  };

  // A line's fit is measured from its start x without its trailing spaces, tabs and forced-break
  // newline, as a trailing tab is not part of the line's text.
  const fitWidth = (a: number, x: number, b: number): number => {
    let e = b;
    while (e > a && isTrailing(text.charCodeAt(e - 1))) e--;
    return advanceFrom(x, a, e) - x;
  };

  const naturalHeight = (font: FontKey): number => {
    const m: LineMetrics = measurer.lineMetrics(font);
    return m.ascent + m.descent + m.lineGap;
  };

  const lineHeight = (a: number, b: number): number => {
    const fonts: FontKey[] = [];
    if (b > a) {
      for (const s of segments) if (s.end > a && s.start < b) fonts.push(s.font);
    } else {
      fonts.push(n === 0 ? input.markFont : fontAt(Math.max(a - 1, 0)));
    }
    const natural = fonts.reduce((max, f) => Math.max(max, naturalHeight(f)), 0);
    const spacing = input.line;
    if (spacing.rule === 'multiple') return spacing.factor * natural;
    if (spacing.rule === 'exact') return spacing.pt;
    return Math.max(spacing.pt, natural);
  };

  const allOpportunities = [
    ...(input.language === undefined
      ? breaks.opportunities(text)
      : breaks.opportunities(text, input.language)),
  ];

  // Forced-break segments: each runs up to and including a newline, and the text after the last
  // newline is a segment of its own (empty when the paragraph ends with a newline).
  const segmentBounds: Array<[number, number]> = [];
  let segStart = 0;
  for (let i = 0; i < n; i++) {
    if (text.charCodeAt(i) === NEWLINE) {
      segmentBounds.push([segStart, i + 1]);
      segStart = i + 1;
    }
  }
  segmentBounds.push([segStart, n]);

  const lines: LayoutLine[] = [];
  let y = 0;
  const pushLine = (from: number, to: number, x: number): number => {
    const height = lineHeight(from, to);
    lines.push({ from, to, x, y, width: fitWidth(from, x, to), height });
    y += height;
    return to;
  };

  for (const [sStart, sEnd] of segmentBounds) {
    if (sStart === sEnd) {
      pushLine(sStart, sStart, lines.length === 0 ? indentLeft + indentFirst : indentLeft);
      continue;
    }
    const candidates = allOpportunities.filter((o) => o > sStart && o < sEnd);
    candidates.push(sEnd);

    let pos = sStart;
    let k = 0;
    while (pos < sEnd) {
      while (k < candidates.length && candidates[k]! <= pos) k++;
      const first = lines.length === 0;
      const x = first ? indentLeft + indentFirst : indentLeft;
      const avail = input.columnWidth - indentRight - x;
      let best = -1;
      for (let j = k; j < candidates.length; j++) {
        const o = candidates[j]!;
        if (fitWidth(pos, x, o) <= avail) best = o;
        else break;
      }
      // Nothing fits: the first opportunity after the line start takes the overflowing word.
      if (best < 0) best = candidates[k]!;
      pos = pushLine(pos, best, x);
    }
  }

  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: input.blockId,
    from: 0,
    to: n,
    x: 0,
    y: 0,
    width: input.columnWidth,
    height: y,
    lines,
  };
  return freezeTree(fragment);
}

/**
 * Breaks one paragraph so that a line starts at each of `starts` (FE-100 criterion 1: a typeset line
 * start is adopted). `starts` are UTF-16 offsets of the paragraph's text, strictly ascending and each
 * in (0, text length); any other value is refused with a `RangeError`. The text is cut at the starts,
 * each piece is broken by `breaker` as a paragraph of its own, and the lines are joined with their
 * offsets moved back into the paragraph. Only the first piece keeps the first-line indent. A piece
 * taller than one line (the typeset line is wider than the editor's measure) gives more lines, so the
 * start after it is still adopted and the extra lines are the editor's. With no starts, the result is
 * the breaker's own. Pure, like `breakParagraph`.
 */
export function breakParagraphAt(
  input: ParagraphInput,
  starts: readonly number[],
  breaker: LineBreaker,
  measurer: TextMeasurer,
  breaks: BreakOpportunities,
): ParagraphFragment {
  const n = input.runs.reduce((sum, r) => sum + r.text.length, 0);
  let previous = 0;
  for (const s of starts) {
    if (!Number.isInteger(s) || s <= previous || s >= n)
      throw new RangeError(`line start ${s} is not strictly inside the paragraph (0, ${n})`);
    previous = s;
  }
  if (starts.length === 0) return breaker.breakParagraph(input, measurer, breaks);
  const bounds = [0, ...starts, n];
  const lines: LayoutLine[] = [];
  let y = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    const part: ParagraphInput = {
      ...input,
      runs: sliceRuns(input.runs, a, b),
      ...(i === 0 ? {} : { indentFirstLine: 0 }),
    };
    const piece = breaker.breakParagraph(part, measurer, breaks);
    for (const l of piece.lines)
      lines.push({
        from: l.from + a,
        to: l.to + a,
        x: l.x,
        y: y + l.y,
        width: l.width,
        height: l.height,
      });
    y += piece.height;
  }
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: input.blockId,
    from: 0,
    to: n,
    x: 0,
    y: 0,
    width: input.columnWidth,
    height: y,
    lines,
  };
  return freezeTree(fragment);
}

/** The runs of `runs` over the text positions [a, b), each run cut to the range, in order. */
function sliceRuns(runs: readonly BreakRun[], a: number, b: number): BreakRun[] {
  const out: BreakRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const lo = Math.max(a, offset);
    const hi = Math.min(b, offset + run.text.length);
    if (lo < hi) out.push({ text: run.text.slice(lo - offset, hi - offset), font: run.font });
    offset += run.text.length;
  }
  return out;
}

/** The greedy first-fit breaker of this file, as a `LineBreaker` (FE-076, FE-081). */
export const firstFitBreaker: LineBreaker = Object.freeze({ id: 'first-fit', breakParagraph });
