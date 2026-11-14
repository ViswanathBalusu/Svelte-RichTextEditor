/**
 * EXP-078 (lane V-EXP-065-080): the comparison of text positions with a reference, on XHTML in the
 * shape `pdftotext -bbox-layout` writes. Runs in Node.js without Podman.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  diffText,
  formatReport,
  parsePages,
  type CorpusEntry,
} from './exp-078-reference-diff.ts';

function page(lines: Array<[string, number, number]>): string {
  const body = lines
    .map(
      ([text, x, y]) =>
        `<line xMin="${x.toFixed(6)}" yMin="${y.toFixed(6)}" xMax="${(x + 100).toFixed(6)}" yMax="${(y + 10).toFixed(6)}">` +
        text
          .split(' ')
          .map((w) => `<word xMin="${x}" yMin="${y}" xMax="${x + 10}" yMax="${y + 10}">${w}</word>`)
          .join('') +
        `</line>`,
    )
    .join('\n');
  return `<page width="595.000000" height="842.000000">\n<flow>\n<block>\n${body}\n</block>\n</flow>\n</page>\n`;
}

function doc(...pages: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<doc>\n${pages.join('')}</doc>\n`;
}

const base = doc(
  page([
    ['Title here', 72, 72],
    ['First paragraph line', 72, 100],
  ]),
  page([
    ['Second page starts', 72, 72],
    ['and continues', 72, 90],
  ]),
);

describe('EXP-078 parsing of pdftotext positions', () => {
  it('reads pages, lines and their positions, joining words with spaces', () => {
    const pages = parsePages(base);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0]!.lines).toEqual([
      { text: 'Title here', xMin: 72, yMin: 72 },
      { text: 'First paragraph line', xMin: 72, yMin: 100 },
    ]);
  });

  it('decodes the character references pdftotext writes', () => {
    expect(decodeEntities('A &amp; B &lt;C&gt; &quot;q&quot; &#38; &#x2014;')).toBe(
      'A & B <C> "q" & —',
    );
  });
});

describe('EXP-078 comparison with the reference', () => {
  it('finds no difference between two identical texts', () => {
    const diff = diffText(parsePages(base), parsePages(base));
    expect(diff.differs).toBe(false);
    expect(diff.moved).toEqual([]);
    expect(diff.breaks).toEqual([]);
    expect(formatReport([{ document: 'same', diff }])).toBe('');
  });

  it('tolerates a move below the tolerance', () => {
    const cand = doc(
      page([
        ['Title here', 72, 72.3],
        ['First paragraph line', 72, 100],
      ]),
      page([
        ['Second page starts', 72, 72],
        ['and continues', 72, 90],
      ]),
    );
    expect(diffText(parsePages(base), parsePages(cand)).differs).toBe(false);
  });

  it('lists a line that moved down, and the page break that moved with it', () => {
    // The first line of page 2 is pushed to page 1 at the bottom, so the page break moves.
    const cand = doc(
      page([
        ['Title here', 72, 72],
        ['First paragraph line', 72, 100],
        ['Second page starts', 72, 120],
      ]),
      page([['and continues', 72, 72]]),
    );
    const diff = diffText(parsePages(base), parsePages(cand));
    expect(diff.differs).toBe(true);
    expect(diff.moved).toEqual([]);
    expect(diff.changed.length).toBeGreaterThan(0);
    expect(diff.breaks).toEqual([
      { page: 2, refFirst: 'Second page starts', candFirst: 'and continues' },
    ]);
    const report = formatReport([{ document: 'pages-x', diff }]);
    expect(report).toContain(
      'pages-x: page break moved, page 2 starts with "and continues", was "Second page starts"',
    );
  });

  it('lists a line that moved in place and names its old and new y', () => {
    const cand = doc(
      page([
        ['Title here', 72, 72],
        ['First paragraph line', 72, 140],
      ]),
      page([
        ['Second page starts', 72, 72],
        ['and continues', 72, 90],
      ]),
    );
    const diff = diffText(parsePages(base), parsePages(cand));
    expect(diff.moved).toEqual([
      { page: 1, text: 'First paragraph line', refX: 72, refY: 100, candX: 72, candY: 140 },
    ]);
    expect(formatReport([{ document: 'pages-x', diff }])).toBe(
      'pages-x: page 1, line "First paragraph line" moved from y 100.00 to y 140.00',
    );
  });

  it('reports a page count change', () => {
    const cand = doc(page([['Title here', 72, 72]]));
    const diff = diffText(parsePages(base), parsePages(cand));
    expect(diff.pageCount).toEqual({ ref: 2, cand: 1 });
    expect(diff.differs).toBe(true);
    expect(formatReport([{ document: 'short', diff }])).toContain(
      'short: page count 2 in the reference, 1 now',
    );
  });

  it('keeps only the differing documents in the corpus run', () => {
    const same = diffText(parsePages(base), parsePages(base));
    const other = diffText(parsePages(base), parsePages(doc(page([['Other', 72, 72]]))));
    const entries: CorpusEntry[] = [
      { document: 'same', diff: same },
      { document: 'other', diff: other },
    ];
    const report = formatReport(entries);
    expect(report).toContain('other:');
    expect(report).not.toContain('same:');
  });
});
