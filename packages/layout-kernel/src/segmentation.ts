/**
 * Unicode segmentation in the kernel (WASM-007; 02 §9.3, §9.6): the line-break opportunities of
 * UAX #14 and the grapheme cluster boundaries of UAX #29, in UTF-16 code units of the block's text
 * (09 §7.1), so that they are the layout tree's offsets.
 *
 * The algorithms and their data come from two pinned crates (`crates/layout-kernel/Cargo.toml`),
 * which implement different versions of Unicode; `unicode` reports both. The kernel corrects the
 * line-break crate in three places (`crates/layout-kernel/src/segment.rs`), so that every case of
 * the Unicode test file of each version passes. Upgrading either crate is a deliberate change that
 * re-runs the conformance tests (`crates/layout-kernel/tests/segmentation.rs` against the files of
 * `crates/layout-kernel/tests/data/`) and the golden file of WASM-010.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */

/** One line-break opportunity. */
export interface LineBreakOpportunity {
  /** The UTF-16 offset of the first unit after the break. */
  readonly offset: number;
  /** True after a hard line break and at the end of the text; false when a break is only allowed. */
  readonly mandatory: boolean;
}

/** The Unicode versions of the segmentation data, as `major.minor.update`. */
export interface SegmentationUnicode {
  /** The version `unicode-linebreak` implements (UAX #14). */
  readonly lineBreak: string;
  /** The version `unicode-segmentation` implements (UAX #29). */
  readonly grapheme: string;
}

/**
 * The kernel's segmentation. Offsets are UTF-16 code units. A lone surrogate counts as one
 * unit, and no break or boundary is ever inside a surrogate pair.
 */
export interface KernelSegmenter {
  /** The Unicode versions of the data the answers follow. */
  readonly unicode: SegmentationUnicode;
  /**
   * Every line-break opportunity of `text` (UAX #14), ascending. The end of a non-empty text is the
   * last one (mandatory). An empty text has none.
   */
  lineBreaks(text: string | Uint16Array, language?: string): LineBreakOpportunity[];
  /**
   * The offsets before the end of the text at which a line may break: the input of
   * `KernelShaper.breakParagraph`, and the answer the layout engine's `BreakOpportunities` gives
   * (`opportunities(text, language?)` has that shape). `language` is the run's BCP 47 tag
   * (WASM-016): Chinese (`zh`) breaks around its curly quotes, Korean (`ko`) breaks at spaces only,
   * and Japanese (`ja`) takes the strict rules, which are the default. Any other tag, and none,
   * gives the default rules.
   */
  opportunities(text: string, language?: string): number[];
  /**
   * The extended grapheme cluster boundaries of `text` (UAX #29), ascending: 0, the start of every
   * cluster after the first, and the length. An empty text has `[0]`. A caret moves between these
   * and a deletion never leaves part of a cluster.
   */
  graphemeBoundaries(text: string | Uint16Array): number[];
}

/** The boundary after `offset` in an ascending list of boundaries, or `offset` at the end. */
export function nextBoundary(boundaries: readonly number[], offset: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((boundaries[mid] ?? 0) <= offset) low = mid + 1;
    else high = mid;
  }
  return boundaries[low] ?? offset;
}

/** The boundary before `offset` in an ascending list of boundaries, or `offset` at the start. */
export function previousBoundary(boundaries: readonly number[], offset: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((boundaries[mid] ?? 0) < offset) low = mid + 1;
    else high = mid;
  }
  return boundaries[low - 1] ?? offset;
}

/** The glue calls that segmentation needs. */
export interface SegmentationGlue {
  line_break_opportunities(text: Uint16Array): Uint32Array;
  line_break_opportunities_for(text: Uint16Array, language: string): Uint32Array;
  grapheme_cluster_boundaries(text: Uint16Array): Uint32Array;
  segment_unicode_versions(): Uint32Array;
}

function units(text: string | Uint16Array): Uint16Array {
  if (typeof text !== 'string') return text;
  const out = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Wraps the module's segmentation calls. */
export function segmenterOver(glue: SegmentationGlue): KernelSegmenter {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = glue.segment_unicode_versions();
  const flatBreaks = (text: string | Uint16Array, language: string | undefined): Uint32Array =>
    language === undefined || language === ''
      ? glue.line_break_opportunities(units(text))
      : glue.line_break_opportunities_for(units(text), language);
  const lineBreaks = (text: string | Uint16Array, language?: string): LineBreakOpportunity[] => {
    const flat = flatBreaks(text, language);
    const out: LineBreakOpportunity[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      out.push({ offset: flat[i] ?? 0, mandatory: flat[i + 1] === 1 });
    return out;
  };
  return {
    unicode: { lineBreak: `${a}.${b}.${c}`, grapheme: `${d}.${e}.${f}` },
    lineBreaks,
    opportunities: (text, language) => {
      const flat = flatBreaks(text, language);
      const out: number[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const offset = flat[i] ?? 0;
        if (offset < text.length) out.push(offset);
      }
      return out;
    },
    graphemeBoundaries: (text) => Array.from(glue.grapheme_cluster_boundaries(units(text))),
  };
}
