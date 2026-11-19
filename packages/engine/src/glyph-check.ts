/**
 * Characters the font lacks (FE-136 criterion 4; 09 §3.2, Missing glyphs). The export converter
 * checks every character against the character map of the run's font and the fallback chain, and a
 * miss stops a final export. The editor says so earlier: when a symbol is inserted, and on request
 * for the whole document.
 *
 * The coverage is not the engine's. The host (the element) reads it from the font files of the
 * manifest and hands it over as a function from a family name to the code point ranges of that
 * family's regular face, or null when it does not know the family. A family with no known coverage
 * is never flagged: a guess would be a false alarm.
 *
 * The family of a run is the one the style cascade gives it (03 §4.5): the direct `fontFamily`
 * mark, else the character style, else the paragraph's style chain. `null` stands for the default
 * face, which the host names.
 */
import { resolveParagraph, resolveRun, styleTable } from '@docedit/model';
import type { Mark, Node as PMNode } from 'prosemirror-model';

/** An inclusive range of code points, sorted and merged (as `fontCoverage` gives them). */
export type GlyphRange = readonly [number, number];

/** A symbol inserted in a font that lacks it; `n` counts notices (FE-136 criterion 4). */
export interface GlyphNotice {
  n: number;
  readonly char: string;
  /** The family the symbol was set in; null for the default face. */
  readonly family: string | null;
}

/** The coverage of a family: null when it is not known. */
export type GlyphCoverage = (family: string | null) => readonly GlyphRange[] | null;

export interface MissingGlyph {
  /** The paragraph that holds the character. */
  readonly blockId: string;
  /** The position of the character in the document. */
  readonly pos: number;
  readonly char: string;
  /** The family the run is set in; null for the default face. */
  readonly family: string | null;
}

/** Characters the class never takes from a font: control characters, spaces and soft hyphens. */
const IGNORED = new Set([0x20, 0xa0, 0xad]);

/** Whether the ranges (sorted, merged) hold the code point. */
export function covered(ranges: readonly GlyphRange[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = ranges[mid]!;
    if (codePoint < from) high = mid - 1;
    else if (codePoint > to) low = mid + 1;
    else return true;
  }
  return false;
}

/** Whether the character is one that a font is expected to have a glyph for. */
function needsGlyph(codePoint: number): boolean {
  return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint < 0xa0) && !IGNORED.has(codePoint);
}

/** The family a run is set in, through the cascade: null when no layer names one. */
function familyOf(
  table: ReturnType<typeof styleTable>,
  paragraph: PMNode,
  marks: readonly Mark[],
): string | null {
  const resolved = resolveParagraph(table, paragraph.attrs);
  if (!resolved.ok) return null;
  const run = resolveRun(
    table,
    resolved.value,
    marks.map((m) => ({ type: m.type.name, attrs: m.attrs })),
  );
  return run.ok ? run.value.fontFamily : null;
}

/** The family of the text at a caret: the paragraph around it and the marks the next typing takes. */
export function familyAtCaret(
  doc: PMNode,
  pos: number,
  marks: readonly Mark[] | null,
): string | null {
  const $pos = doc.resolve(pos);
  const paragraph = $pos.parent;
  if (paragraph.type.name !== 'paragraph') return null;
  return familyOf(styleTable(doc), paragraph, marks ?? $pos.marks());
}

/**
 * Whether `char` has no glyph in the family: false when the coverage does not know the family, or
 * when the character is a space or a control character.
 */
export function lacksGlyph(coverage: GlyphCoverage, family: string | null, char: string): boolean {
  const cp = char.codePointAt(0);
  if (cp === undefined || !needsGlyph(cp)) return false;
  const ranges = coverage(family);
  return ranges !== null && !covered(ranges, cp);
}

/**
 * Every character of the body's text that its family lacks, in document order, with the family and
 * the paragraph. Each distinct character is listed once for each paragraph. Stories and footnotes
 * are not searched.
 */
export function missingGlyphs(doc: PMNode, coverage: GlyphCoverage): MissingGlyph[] {
  const out: MissingGlyph[] = [];
  const table = styleTable(doc);
  doc.forEach((top, topOffset) => {
    if (top.type.name !== 'body') return;
    top.descendants((node, at) => {
      if (node.type.name !== 'paragraph') return true;
      const blockId = String(node.attrs['id'] ?? '');
      const seen = new Set<string>();
      node.forEach((child, offset) => {
        if (!child.isText || child.text === undefined) return;
        const family = familyOf(table, node, child.marks);
        let at2 = 0;
        for (const char of child.text) {
          const here = topOffset + 1 + at + 1 + offset + at2;
          at2 += char.length;
          const key = `${family ?? ''}\u0000${char}`;
          if (seen.has(key) || !lacksGlyph(coverage, family, char)) continue;
          seen.add(key);
          out.push({ blockId, pos: here, char, family });
        }
      });
      return false;
    });
  });
  return out;
}
