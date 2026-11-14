/**
 * What spike S5 asks of a shaper: shape a run of text in one font file and report glyphs and
 * advances in font units. Both WebAssembly shapers (harfbuzzjs and the HarfRust module) implement
 * it, so the measurement code treats them alike.
 */

export interface ShapedGlyph {
  readonly glyph: number;
  /** UTF-16 offset of the glyph's cluster in the shaped text. */
  readonly cluster: number;
  /** Advance in font units. */
  readonly advance: number;
  /** Horizontal offset in font units. */
  readonly offset: number;
}

/** Feature switches: bit 0 turns kerning off, bit 1 standard and contextual ligatures off. */
export const NO_KERN = 1;
export const NO_LIGA = 2;

export interface Shaper {
  /** Name and version, for result files. */
  readonly name: string;
  /** Registers a font file under an identifier. */
  loadFont(id: string, bytes: Uint8Array): void;
  /** Units per em of a registered font. */
  upem(id: string): number;
  shape(id: string, text: string, flags?: number): ShapedGlyph[];
  /** Sum of the advances of `text` in font units. */
  width(id: string, text: string): number;
  /** Size of the module's linear memory in bytes. */
  memoryBytes(): number;
}

/** A digest input for a shaping result: glyph, cluster, advance and offset of every glyph. */
export function glyphKey(glyphs: readonly ShapedGlyph[]): string {
  return glyphs.map((g) => `${g.glyph}@${g.cluster}+${g.advance}/${g.offset}`).join(' ');
}
