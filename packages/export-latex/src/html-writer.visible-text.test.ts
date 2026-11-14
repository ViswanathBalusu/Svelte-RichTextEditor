/**
 * EXP-087 criterion 5 for the structures the paragraph test in `html-writer.test.ts` does not cover:
 * headings, bullet and numbered lists (nested), and a table with a column span. The visible text is
 * what a reader sees in the body: the tags become spaces, the entities are decoded, and the list
 * labels (`•`, `1.`, `1.1.`) count as visible text, because the reader sees them. The expected text
 * is written out by hand from the document, not read back from the writer. Node.js only; nothing
 * renders the page in a browser.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { htmlText } from './html-writer.ts';

const styleH1: J = {
  type: 'style_def',
  attrs: { id: 'Heading1', kind: 'paragraph', name: 'Heading 1', outlineLevel: 0 },
};
const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});
const decimal = (n: number): J[] =>
  Array.from({ length: n }, (_, i) => ({
    format: 'decimal',
    text: `${Array.from({ length: i + 1 }, (_v, k) => `%${k + 1}`).join('.')}.`,
    start: 1,
  }));
const bullets: J = { format: 'bullet', text: '•', start: 1, bulletChar: '•' };
const item = (content: string, level: number, listId: string, numberingId: string): J =>
  para(content, { numbering: { numberingId, level, listId } });

const DECODE: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** The text a reader sees in the body: tags as spaces, entities decoded, runs of spaces folded. */
function visibleText(html: string): string {
  const body = html.slice(html.indexOf('<body>'));
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => DECODE[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

describe('EXP-087 criterion 5: the visible text equals the document text for headings, lists and tables', () => {
  it('reads back the heading, the nested bullet and numbered lists, the table cells and the closing paragraph', () => {
    const cell = (c: string, attrs: J = {}): J => ({
      type: 'table_cell',
      attrs: { id: nid('c'), ...attrs },
      content: [para(c)],
    });
    const row = (cells: J[]): J => ({ type: 'table_row', attrs: { id: nid('r') }, content: cells });
    const body: J[] = [
      para('Report', { style: 'Heading1' }),
      item('Alpha', 0, 'B', 'b'),
      item('Beta', 1, 'B', 'b'),
      item('Gamma', 0, 'B', 'b'),
      item('One', 0, 'N', 'n'),
      item('Sub', 1, 'N', 'n'),
      {
        type: 'table',
        attrs: { id: nid('t') },
        content: [row([cell('Wide', { colspan: 2 })]), row([cell('a'), cell('b')])],
      },
      para('End & done.'),
    ];
    const env = doc(body, {
      styles: [styleH1],
      numberings: [numbering('b', [bullets, bullets]), numbering('n', decimal(2))],
    });
    const r = htmlText(env);
    expect(r.ok).toBe(true);
    expect(visibleText(r.text)).toBe(
      'Report • Alpha • Beta • Gamma 1. One 1.1. Sub Wide a b End & done.',
    );
  });
});
