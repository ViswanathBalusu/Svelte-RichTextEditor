/**
 * EXP-088 criterion 2, checked by rendering: the Markdown the writer produces is read by a
 * CommonMark renderer (markdown-it, a test-only dependency of this package, owner decision 243), and
 * the text it renders equals the typed text. Nothing here ships.
 */
import fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { markdownText } from './markdown-writer.ts';

type Token = ReturnType<MarkdownIt['parse']>[number];

const renderer = new MarkdownIt('default', { html: true, linkify: false, typographer: false });

/** The text of each inline block, in document order, as the renderer reads it (not as HTML). */
function renderedTexts(source: string): string[] {
  const out: string[] = [];
  const walk = (tokens: readonly Token[]): string => {
    let s = '';
    for (const t of tokens) {
      if (t.type === 'text' || t.type === 'code_inline' || t.type === 'text_special')
        s += t.content;
      else if (t.type === 'softbreak' || t.type === 'hardbreak') s += '\n';
      else if (t.type === 'html_inline' || t.type === 'image') s += `[[${t.type}:${t.content}]]`;
      else if (t.children) s += walk(t.children);
    }
    return s;
  };
  for (const t of renderer.parse(source, {})) {
    if (t.type === 'inline') out.push(walk(t.children ?? []));
    else if (t.type === 'html_block' || t.type === 'fence' || t.type === 'code_block') {
      out.push(`[[${t.type}:${t.content}]]`);
    }
  }
  return out;
}

const printable = fc.constantFrom(
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)),
  'é',
  '日',
  '本',
  ' ',
  '\u{1F600}',
);
// Leading and trailing blanks are not part of a paragraph's rendered text, so the typed texts have
// none (the writer keeps the spaces of a run outside the markers, which is covered elsewhere).
const typedText = fc
  .array(printable, { minLength: 1, maxLength: 60 })
  .map((cs) => cs.join(''))
  .filter((s) => s === s.trim() && s.length > 0);

/**
 * The tricky starts and shapes that a line of plain text can take: each is a construct Markdown would
 * read as something other than text if it were not escaped.
 */
const awkward = [
  '# Heading',
  '## Two',
  '- item',
  '+ item',
  '* item',
  '> quote',
  '1. one',
  '2) two',
  '10. ten',
  '---',
  '***',
  '___',
  '===',
  '```code```',
  '~~~',
  '~~struck~~',
  '| a | b |',
  '|---|---|',
  '[link](https://example.com)',
  '![alt](x.png)',
  '[ref]: https://example.com',
  '<b>bold</b>',
  '<https://example.com>',
  '<!-- comment -->',
  '&amp; &lt; &#35; &copy',
  'a*b*c and _d_ and __e__',
  'snake_case_name',
  '2 * 3 * 4',
  'back\\slash and \\* and trailing\\',
  'Use *stars*, [brackets] & <tags> | pipes # hash.',
  'a  b   c',
  '\\<b\\>',
  '`tick` and ``double``',
];

describe('EXP-088 criterion 2: the rendered text equals the typed text (markdown-it)', () => {
  it('renders each awkward line as the same characters, as a paragraph on its own', () => {
    for (const typed of awkward) {
      const out = markdownText(doc([para(typed)]), {}, {});
      expect(renderedTexts(out.text), JSON.stringify(typed)).toEqual([typed]);
    }
  });

  it('renders all the awkward lines, one paragraph each, in one document in order', () => {
    const out = markdownText(doc(awkward.map((t) => para(t))), {}, {});
    expect(renderedTexts(out.text)).toEqual(awkward);
  });

  it('renders any printable text as typed (fast-check, seed 20261126)', () => {
    fc.assert(
      fc.property(fc.array(typedText, { minLength: 1, maxLength: 4 }), (texts) => {
        const out = markdownText(doc(texts.map((t) => para(t))), {}, {});
        expect(renderedTexts(out.text), out.text).toEqual(texts);
      }),
      { seed: 20261126, numRuns: 400 },
    );
  });

  it('renders the text of table cells as typed, including a pipe', () => {
    const cell = (c: string): J => ({
      type: 'table_cell',
      attrs: { id: nid('c') },
      content: [para(c)],
    });
    const row = (cells: string[]): J => ({
      type: 'table_row',
      attrs: { id: nid('r') },
      content: cells.map(cell),
    });
    const cells = ['a | b', '*x*', '1. y', '<i>', '\\', '[z](u)'];
    const table: J = {
      type: 'table',
      attrs: { id: nid('t') },
      content: [row(['H1', 'H2', 'H3']), row(cells.slice(0, 3)), row(cells.slice(3))],
    };
    const out = markdownText(doc([table]), {}, {});
    expect(renderedTexts(out.text)).toEqual(['H1', 'H2', 'H3', ...cells]);
  });
});
