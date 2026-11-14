/**
 * Text measurement, injected (02 §9.1, §9.3; FE-076, FE-079). The layout engine never measures
 * text itself: whoever constructs it passes a `TextMeasurer`. In the browser that is canvas
 * `measureText` or a shaper over the manifest's font files (spike S5); in Node.js tests it is one of
 * the deterministic stubs below.
 *
 * The interface is plain data in and out (font alias, size and text in; advances out), so that a
 * kernel compiled to WebAssembly can sit behind it (ADR 0016; spike S10).
 *
 * Every length is in points.
 */

/** The face and size a run is measured in. `family` is a font alias, never a CSS font list. */
export interface FontKey {
  readonly family: string;
  /** Font size in points. */
  readonly sizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** Vertical metrics of a face at a size, in points. */
export interface LineMetrics {
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
}

export interface TextMeasurer {
  /** Identifies the measurer and its fonts, for caches and for test results (font epoch, 02 §6). */
  readonly id: string;
  /** The advance width of `text` set in `font`, in points. */
  advance(font: FontKey, text: string): number;
  /**
   * Optional: the advance of each UTF-16 code unit of `text`, in points, summing to
   * `advance(font, text)`; the second unit of a surrogate pair and ligature interiors carry 0.
   * One call then answers caret positions and breaks inside a run, which is what a kernel behind a
   * WebAssembly boundary needs (S10).
   */
  advances?(font: FontKey, text: string): readonly number[];
  /** The face's vertical metrics at `font.sizePt`, in points. */
  lineMetrics(font: FontKey): LineMetrics;
}

/**
 * A stub where every UTF-16 code unit has the same advance, `emWidth` times the font size, and
 * every face has the same vertical metrics. Bold and italic do not change widths.
 */
export function fixedWidthMeasurer(
  options: { emWidth?: number; ascent?: number; descent?: number } = {},
): TextMeasurer {
  const emWidth = options.emWidth ?? 0.5;
  const ascent = options.ascent ?? 0.8;
  const descent = options.descent ?? 0.2;
  return {
    id: `fixed-width/${emWidth}/${ascent}/${descent}`,
    advance: (font, text) => text.length * emWidth * font.sizePt,
    advances: (font, text) => Array.from({ length: text.length }, () => emWidth * font.sizePt),
    lineMetrics: (font) => ({
      ascent: ascent * font.sizePt,
      descent: descent * font.sizePt,
      lineGap: 0,
    }),
  };
}

/** Advances in thousandths of an em, by character class. */
export interface AdvanceTable {
  readonly name: string;
  /** Advances for single characters; anything not listed falls back to its class below. */
  readonly chars: Readonly<Record<string, number>>;
  readonly lowercase: number;
  readonly uppercase: number;
  readonly digit: number;
  readonly space: number;
  readonly punctuation: number;
  /** Ideographs, kana and hangul. */
  readonly wide: number;
  readonly other: number;
  /** Multiplier for bold faces. */
  readonly boldFactor: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
}

/**
 * A synthetic proportional table, made up for tests: narrow and wide letters differ as in a
 * typical serif face, but the numbers are not the metrics of any real font. Use it to exercise
 * proportional breaking; use canvas or the font files (S5) for real widths.
 */
export const SYNTHETIC_SERIF: AdvanceTable = {
  name: 'synthetic-serif',
  chars: {
    i: 280,
    j: 280,
    l: 280,
    f: 330,
    t: 330,
    r: 390,
    m: 830,
    w: 760,
    I: 340,
    J: 380,
    M: 880,
    W: 940,
    '.': 250,
    ',': 250,
    ':': 270,
    ';': 270,
    '-': 330,
    ' ': 250,
  },
  lowercase: 520,
  uppercase: 680,
  digit: 520,
  space: 250,
  punctuation: 330,
  wide: 1000,
  other: 560,
  boldFactor: 1.06,
  ascent: 0.9,
  descent: 0.25,
  lineGap: 0,
};

const WIDE = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-힯豈-﫿＀-￯]/;

function classAdvance(table: AdvanceTable, ch: string): number {
  const listed = table.chars[ch];
  if (listed !== undefined) return listed;
  if (ch === ' ') return table.space;
  if (ch >= 'a' && ch <= 'z') return table.lowercase;
  if (ch >= 'A' && ch <= 'Z') return table.uppercase;
  if (ch >= '0' && ch <= '9') return table.digit;
  if (WIDE.test(ch)) return table.wide;
  if (/[!-/:-@[-`{-~]/.test(ch)) return table.punctuation;
  return table.other;
}

/** A stub that sums per-character advances from a table; deterministic and kerning-free. */
export function advanceTableMeasurer(table: AdvanceTable = SYNTHETIC_SERIF): TextMeasurer {
  const scale = (font: FontKey): number =>
    (font.sizePt / 1000) * (font.bold ? table.boldFactor : 1);
  return {
    id: `advance-table/${table.name}`,
    advance(font, text) {
      let units = 0;
      for (const ch of text) units += classAdvance(table, ch);
      return units * scale(font);
    },
    advances(font, text) {
      const out: number[] = [];
      for (const ch of text) {
        out.push(classAdvance(table, ch) * scale(font));
        if (ch.length === 2) out.push(0);
      }
      return out;
    },
    lineMetrics: (font) => ({
      ascent: table.ascent * font.sizePt,
      descent: table.descent * font.sizePt,
      lineGap: table.lineGap * font.sizePt,
    }),
  };
}

/**
 * Memoises a measurer by font alias, size, weight, slant and text, under a font epoch that a later
 * font load advances (02 §6, §9.3; FE-079). Engines that leave caching to the measurer, as
 * Eigenpal's does, need it; Docen caches internally.
 */
export function cachingMeasurer(inner: TextMeasurer, epoch = 0): TextMeasurer {
  const widths = new Map<string, number>();
  const perUnit = new Map<string, readonly number[]>();
  const metrics = new Map<string, LineMetrics>();
  const fontKey = (f: FontKey): string =>
    `${f.family}\u0000${f.sizePt}\u0000${f.bold ? 'b' : ''}${f.italic ? 'i' : ''}`;
  const innerAdvances = inner.advances?.bind(inner);
  return {
    id: `${inner.id}+cache@${epoch}`,
    advance(font, text) {
      const k = `${fontKey(font)}\u0000${text}`;
      let v = widths.get(k);
      if (v === undefined) {
        v = inner.advance(font, text);
        widths.set(k, v);
      }
      return v;
    },
    ...(innerAdvances
      ? {
          advances(font: FontKey, text: string) {
            const k = `${fontKey(font)}\u0000${text}`;
            let v = perUnit.get(k);
            if (v === undefined) {
              v = innerAdvances(font, text);
              perUnit.set(k, v);
            }
            return v;
          },
        }
      : {}),
    lineMetrics(font) {
      const k = fontKey(font);
      let v = metrics.get(k);
      if (v === undefined) {
        v = inner.lineMetrics(font);
        metrics.set(k, v);
      }
      return v;
    },
  };
}

/** What a measurer was asked to do during one layout pass (evidence for S10's kernel boundary). */
export interface MeasureStats {
  advanceCalls: number;
  /** UTF-16 code units passed to `advance`, summed over calls. */
  advanceUnits: number;
  advancesCalls: number;
  advancesUnits: number;
  lineMetricsCalls: number;
}

/** Wraps a measurer and counts its calls. `advances` is offered only when `inner` has it. */
export function countingMeasurer(
  inner: TextMeasurer,
  options: { offerAdvances?: boolean } = {},
): { measurer: TextMeasurer; stats: MeasureStats } {
  const stats: MeasureStats = {
    advanceCalls: 0,
    advanceUnits: 0,
    advancesCalls: 0,
    advancesUnits: 0,
    lineMetricsCalls: 0,
  };
  const perUnit = inner.advances?.bind(inner);
  const measurer: TextMeasurer = {
    id: inner.id,
    advance(font, text) {
      stats.advanceCalls++;
      stats.advanceUnits += text.length;
      return inner.advance(font, text);
    },
    ...(perUnit && options.offerAdvances !== false
      ? {
          advances(font: FontKey, text: string) {
            stats.advancesCalls++;
            stats.advancesUnits += text.length;
            return perUnit(font, text);
          },
        }
      : {}),
    lineMetrics(font) {
      stats.lineMetricsCalls++;
      return inner.lineMetrics(font);
    },
  };
  return { stats, measurer };
}
