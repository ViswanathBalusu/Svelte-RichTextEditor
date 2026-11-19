/**
 * What the kernel's line breaker takes and gives (WASM-008; 02 §9.3, §9.7; 09 §7.1).
 *
 * A paragraph is its text (`blockText`), the runs the text is set in, the break opportunities, and
 * the column's geometry; the answer is its lines. Every length is a whole number of advance units
 * (1/1280 pt, see `KernelShaper`), so the answer is exact and the same in every runtime. Offsets are
 * UTF-16 code units of the block's text, in which each inline atom is one unit and a bookmark is
 * none: the rule of `layout.json` (09 §7.1), so that the engine can compare its breaks with the
 * typesetter's and adopt them (02 §9.7).
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */

/** The character that stands for an inline atom in the block's text: one code unit. */
export const ATOM_UNIT = '￼';

/** One inline item of a block, in order. */
export type BlockItem =
  | { readonly kind: 'text'; readonly text: string }
  /** An inline atom (an image, an equation, a field): one unit of the block's text. */
  | { readonly kind: 'atom' }
  /** A bookmark: no unit. */
  | { readonly kind: 'bookmark' };

/** The block's text under the offset rule of 09 §7.1: an atom is one unit, a bookmark none. */
export function blockText(items: readonly BlockItem[]): string {
  let out = '';
  for (const item of items) {
    if (item.kind === 'text') out += item.text;
    else if (item.kind === 'atom') out += ATOM_UNIT;
  }
  return out;
}

/** How a tab stop aligns the text after the tab. */
export type TabAlign = 'left' | 'center' | 'right' | 'decimal';

export interface ParagraphTabStop {
  /** From the column's left edge, in advance units. */
  readonly position: number;
  readonly align: TabAlign;
}

/** A run of the paragraph's text, shaped in one face at one size, or a box of a fixed width. */
export interface ParagraphRun {
  /** The code units the run covers (an atom is one). Runs are contiguous and cover the text. */
  readonly length: number;
  readonly alias: string;
  readonly sizeTwips: number;
  readonly language: string;
  readonly features: string;
  /** Set for an atom: its width in advance units, whatever its unit is. Absent for text. */
  readonly boxWidth?: number;
}

export interface ParagraphInput {
  readonly text: string;
  readonly runs: readonly ParagraphRun[];
  /** Offsets at which a break is allowed (UAX #14), ascending. */
  readonly opportunities: readonly number[];
  /** All of these in advance units. */
  readonly columnWidth: number;
  readonly indentLeft?: number;
  readonly indentRight?: number;
  /** Added to `indentLeft` on the first line; negative for a hanging indent. */
  readonly indentFirstLine?: number;
  readonly tabStops?: readonly ParagraphTabStop[];
  /** The spacing of default stops past the last stop; 0 for none. */
  readonly defaultTabStop?: number;
  /** Report the word spacing of every line but the last. */
  readonly justify?: boolean;
}

/** One line of the answer. */
export interface BrokenLine {
  /** The offset of the line's first code unit. */
  readonly from: number;
  /** The offset after its last: the next line's start. */
  readonly to: number;
  /** Where the line starts, in advance units from the column's left edge. */
  readonly x: number;
  /** The width of the line without its trailing spaces, tabs and newline. */
  readonly width: number;
  /** A justified line: the space to add, in advance units; 0 otherwise. */
  readonly extra: number;
  /** A justified line: the stretchable spaces that share `extra`; 0 otherwise. */
  readonly spaces: number;
  /**
   * The word spacing to add after each stretchable space, in advance units: `extra / spaces`, not
   * rounded; 0 when the line is not stretched. Tabs and trailing spaces never stretch.
   */
  readonly wordSpacing: number;
}

const ALIGN_CODE: Record<TabAlign, number> = { left: 0, center: 1, right: 2, decimal: 3 };

/** The arrays the crate's `break_paragraph` takes. */
export interface PackedParagraph {
  readonly text: Uint16Array;
  readonly runEnds: Uint32Array;
  readonly aliases: string[];
  readonly sizes: Uint32Array;
  readonly languages: string[];
  readonly features: string[];
  readonly boxes: Int32Array;
  readonly opportunities: Uint32Array;
  readonly geometry: Int32Array;
  readonly tabStops: Int32Array;
}

/** Packs a paragraph for the crate. Throws a `RangeError` when the runs do not cover the text. */
export function packParagraph(p: ParagraphInput): PackedParagraph {
  const text = new Uint16Array(p.text.length);
  for (let i = 0; i < p.text.length; i++) text[i] = p.text.charCodeAt(i);
  const runs = p.runs.filter((r) => r.length > 0);
  const total = runs.reduce((sum, r) => sum + r.length, 0);
  if (total !== p.text.length)
    throw new RangeError(`the runs cover ${total} code units, the text has ${p.text.length}`);
  const ends = new Uint32Array(runs.length);
  let at = 0;
  runs.forEach((r, i) => {
    at += r.length;
    ends[i] = at;
  });
  return {
    text,
    runEnds: ends,
    aliases: runs.map((r) => r.alias),
    sizes: Uint32Array.from(runs, (r) => r.sizeTwips),
    languages: runs.map((r) => r.language),
    features: runs.map((r) => r.features),
    boxes: Int32Array.from(runs, (r) => (r.boxWidth === undefined ? -1 : r.boxWidth)),
    opportunities: Uint32Array.from(p.opportunities),
    geometry: Int32Array.from([
      p.columnWidth,
      p.indentLeft ?? 0,
      p.indentRight ?? 0,
      p.indentFirstLine ?? 0,
      p.defaultTabStop ?? 0,
    ]),
    tabStops: Int32Array.from((p.tabStops ?? []).flatMap((s) => [s.position, ALIGN_CODE[s.align]])),
  };
}

/** The lines the crate answered with: six numbers for each, as `break_paragraph` writes them. */
export function unpackLines(flat: ArrayLike<number>): BrokenLine[] {
  const lines: BrokenLine[] = [];
  for (let i = 0; i + 5 < flat.length; i += 6) {
    const [from = 0, to = 0, x = 0, width = 0, extra = 0, spaces = 0] = [
      flat[i],
      flat[i + 1],
      flat[i + 2],
      flat[i + 3],
      flat[i + 4],
      flat[i + 5],
    ];
    lines.push({
      from,
      to,
      x,
      width,
      extra,
      spaces,
      wordSpacing: spaces > 0 ? extra / spaces : 0,
    });
  }
  return lines;
}
