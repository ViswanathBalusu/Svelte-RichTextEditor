/**
 * Spike S9 (SPK-022): a first-fit layout of the spike document into the project's layout tree
 * (`@docedit/layout`, FE-078). It exists so that the bridge prototype runs on the real tree and the
 * real caret functions; it is not the layout engine. Lines break after a space; a word wider than
 * the line is cut where it overflows. Widths come from an injected `measure` (points), the one the
 * page also uses for the caret.
 *
 * No DOM and no Node.js API.
 */
import type { LayoutFragment, LayoutLine, LayoutPage, LayoutTree } from '@docedit/layout';
import type { SpikeDoc } from './doc.ts';

export interface PageGeometry {
  /** Page size and margin, in points. */
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  readonly lineHeight: number;
  /** Space after each paragraph. */
  readonly gap: number;
}

export const SPIKE_PAGE: PageGeometry = {
  width: 260,
  height: 150,
  margin: 20,
  lineHeight: 16,
  gap: 6,
};

export type Measure = (text: string) => number;

/** The lines of one paragraph as `[from, to)` ranges. An empty paragraph has one empty line. */
export function breakLines(text: string, width: number, measure: Measure): Array<[number, number]> {
  if (text.length === 0) return [[0, 0]];
  const lines: Array<[number, number]> = [];
  let from = 0;
  while (from < text.length) {
    let to = from;
    let lastFit = -1;
    while (to < text.length) {
      let end = to;
      while (end < text.length && text[end] !== ' ') end++;
      const wordEnd = end;
      while (end < text.length && text[end] === ' ') end++;
      if (measure(text.slice(from, wordEnd)) > width && lastFit >= 0) break;
      if (measure(text.slice(from, wordEnd)) > width) {
        // One word wider than the line: cut it at the last character that fits.
        let cut = from + 1;
        while (cut < wordEnd && measure(text.slice(from, cut + 1)) <= width) cut++;
        lastFit = cut;
        break;
      }
      lastFit = end;
      to = end;
    }
    if (lastFit < 0) lastFit = Math.min(text.length, from + 1);
    lines.push([from, lastFit]);
    from = lastFit;
  }
  return lines;
}

export function layoutSpikeDoc(
  doc: SpikeDoc,
  measure: Measure,
  geometry: PageGeometry = SPIKE_PAGE,
): LayoutTree {
  const g = geometry;
  const contentWidth = g.width - 2 * g.margin;
  const bottom = g.height - g.margin;
  const pages: LayoutPage[] = [];
  let fragments: LayoutFragment[] = [];
  let y = g.margin;
  const closePage = (): void => {
    pages.push({
      index: pages.length,
      section: 0,
      width: g.width,
      height: g.height,
      fragments,
      header: [],
      footer: [],
      footnotes: [],
    });
    fragments = [];
    y = g.margin;
  };
  for (const block of doc.blocks) {
    const ranges = breakLines(block.text, contentWidth, measure);
    let i = 0;
    while (i < ranges.length) {
      const room = Math.max(1, Math.floor((bottom - y) / g.lineHeight));
      const take = ranges.slice(i, i + room);
      const lines: LayoutLine[] = take.map(([from, to], k) => ({
        from,
        to,
        x: 0,
        y: k * g.lineHeight,
        width: measure(block.text.slice(from, to).replace(/ +$/, '')),
        height: g.lineHeight,
      }));
      const first = take[0]!;
      const last = take[take.length - 1]!;
      fragments.push({
        kind: 'paragraph',
        blockId: block.id,
        from: first[0],
        to: last[1],
        x: g.margin,
        y,
        width: contentWidth,
        height: take.length * g.lineHeight,
        lines,
      });
      y += take.length * g.lineHeight;
      i += take.length;
      if (i < ranges.length) closePage();
    }
    y += g.gap;
    if (y + g.lineHeight > bottom) closePage();
  }
  if (fragments.length > 0 || pages.length === 0) closePage();
  return { engine: 's9-spike', measurer: 'injected', pages };
}
