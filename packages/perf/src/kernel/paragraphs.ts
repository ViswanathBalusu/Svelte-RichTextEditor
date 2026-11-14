/**
 * Kernel input from a corpus document: every paragraph of the body (table cells included) and of
 * the footnotes as text, runs and a line width, in the same form in Node.js and in browsers.
 *
 * - Text inlines are joined; a line break becomes U+2028 (a mandatory break in UAX #14), a tab a
 *   space; pictures and other boxes are left out.
 * - Runs are split where the font changes and where the text changes script class (src/fonts.ts):
 *   CJK text takes the CJK face, as a browser's font fallback would. Korean text has no face in
 *   the manifest and is measured with the CJK face's missing-glyph advances; S10 measures time, so
 *   this is noted, not corrected.
 * - The width is the column's text width less the paragraph's indents, or the cell's width less
 *   its margins in a table. The first-line indent is ignored.
 */
import type { FlowBlock, FlowDocument, FlowParagraph, FontKey } from '@docedit/layout';
import { faceFor, roleOf, type FontRole } from '../fonts.ts';
import type { KernelParagraph, KernelRun } from './types.ts';

const NEUTRAL = /[\s\d!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u206f]/;

function paragraph(p: FlowParagraph, width: number): KernelParagraph | null {
  let text = '';
  const runs: KernelRun[] = [];
  let role: FontRole = 'latin';
  const push = (s: string, font: FontKey): void => {
    for (const ch of s) {
      const r = NEUTRAL.test(ch) ? role : roleOf(ch);
      role = r;
      const face = faceFor(font.family, font.bold, font.italic, r === 'hangul' ? 'cjk' : r);
      const key: FontKey = {
        family: face.alias,
        sizePt: font.sizePt,
        bold: face.weight === 700,
        italic: face.style === 'italic',
      };
      const last = runs[runs.length - 1];
      const start = text.length;
      text += ch;
      if (
        last &&
        last.end === start &&
        last.font.family === key.family &&
        last.font.sizePt === key.sizePt &&
        last.font.bold === key.bold &&
        last.font.italic === key.italic
      )
        runs[runs.length - 1] = { ...last, end: text.length };
      else runs.push({ start, end: text.length, font: key });
    }
  };
  for (const inline of p.inlines) {
    if (inline.kind === 'text') push(inline.text, inline.font);
    else if (inline.kind === 'tab') push(' ', inline.font);
    else if (inline.kind === 'lineBreak') push('\u2028', inline.font);
  }
  if (!text) return null;
  // A floor of half an inch keeps a degenerate cell or indent from giving a width of zero.
  return { text, runs, widthPt: Math.max(36, width - p.indentLeft - p.indentRight) };
}

function collect(blocks: readonly FlowBlock[], width: number, out: KernelParagraph[]): void {
  for (const b of blocks) {
    if (b.kind === 'paragraph') {
      const k = paragraph(b, width);
      if (k) out.push(k);
    } else if (b.kind === 'table') {
      for (const row of b.rows) {
        let col = 0;
        for (const cell of row.cells) {
          let w = 0;
          for (let i = 0; i < cell.colspan; i++) w += b.columnWidths[col + i] ?? 0;
          col += cell.colspan;
          collect(cell.blocks, w - cell.margins.left - cell.margins.right, out);
        }
      }
    }
  }
}

export function kernelParagraphs(flow: FlowDocument): KernelParagraph[] {
  const out: KernelParagraph[] = [];
  // Footnotes take the width of the last section's columns.
  let lastWidth = 0;
  for (const s of flow.sections) {
    const p = s.page;
    const width =
      (p.width - p.marginLeft - p.marginRight - (p.columns - 1) * p.columnGap) / p.columns;
    lastWidth = width;
    collect(s.blocks, width, out);
  }
  for (const n of flow.notes.values()) collect(n.blocks, lastWidth, out);
  return out;
}
