/**
 * EXP-057, criteria 2 and 3: the table rows on each page, the column breaks, and the fallback to
 * block-level starts, built from a raw report and map.json without a compile. The compile tests
 * (packages/export-latex/src/exp-057-rows-columns.compile.test.ts) show the same on a real PDF.
 */
import { describe, expect, it } from 'vitest';
import type { SourceMap } from '@docedit/export-latex';
import { buildLayout, parseRawLayout, validateLayout } from './layout.ts';

const T = 'tAAAAAAAAAAAAAAA';
const C1 = 'cAAAAAAAAAAAAAA1';
const C2 = 'cAAAAAAAAAAAAAA2';
const C3 = 'cAAAAAAAAAAAAAA3';
const P = 'pAAAAAAAAAAAAAAA';
const E = 'eAAAAAAAAAAAAAAA';
const SP = 65781.76 / 20;
const sp = (twips: number): number => Math.round(twips * SP);

// Block numbers: 1 table, 2 to 4 cell paragraphs (row 0 holds 2 and 3, row 1 holds 4, row 2 none),
// 5 a paragraph set in two columns, 6 an empty-looking paragraph with no line.
const map: SourceMap = {
  version: 1,
  blocks: [null, T, C1, C2, C3, P, E],
  kinds: ['', 'table', 'cellParagraph', 'cellParagraph', 'cellParagraph', 'paragraph', 'paragraph'],
  owners: [null, null, T, T, T, null, null],
  lines: [],
  setups: ['ps1'],
  tables: {
    [T]: [
      [2, 4],
      [4, 5],
      [5, 5],
    ],
  },
};

const raw = (level: number, lines: unknown[]): string =>
  JSON.stringify({
    v: 1,
    level,
    pages: [
      { n: 1, w: 39159881, h: 55381663, start: [1, 0, sp(1440)], first: [1, 1] },
      { n: 2, w: 39159881, h: 55381663, start: [4, 0, sp(1440)], first: [4, 1] },
    ],
    blocks: {
      '1': [1, sp(1440), 0],
      '2': [1, sp(1500), 0],
      '3': [1, sp(1500), 0],
      '4': [2, sp(1500), 0],
      '5': [2, sp(4000), 0],
      '6': [2, sp(9000), 0],
    },
    lines,
  });

const meta = { seq: 1, classVersion: '0.1.0-s4', setup: 'ps1' };

describe('EXP-057 criterion 2: table rows per page and column breaks', () => {
  const lines = [
    [2, 0, 1, sp(1500)],
    [3, 0, 1, sp(1500)],
    [4, 0, 2, sp(1500)],
    // A paragraph in two columns: three lines in the first, down the page, then two at the top of the second.
    [5, 0, 2, sp(4000)],
    [5, 50, 2, sp(4300)],
    [5, 100, 2, sp(4600)],
    [5, 150, 2, sp(4000)],
    [5, 200, 2, sp(4300)],
  ];
  const layout = buildLayout(parseRawLayout(raw(2, lines)), map, meta);

  it('lists the page each row of a table starts on, with null for a row without material', () => {
    expect(layout.blocks[T]?.rowPages).toEqual([1, 2, null]);
    expect(validateLayout(layout)).toEqual([]);
  });

  it('reports the lines that start a column, as indexes into lineStarts', () => {
    expect(layout.blocks[P]?.lineStarts).toEqual([0, 50, 100, 150, 200]);
    expect(layout.blocks[P]?.columnBreaks).toEqual([3]);
  });

  it('reports no column break for lines that run down one column, or across a page', () => {
    const down = buildLayout(
      parseRawLayout(
        raw(2, [
          [5, 0, 1, sp(8000)],
          [5, 50, 2, sp(1500)],
          [5, 100, 2, sp(1800)],
        ]),
      ),
      map,
      meta,
    );
    expect(down.blocks[P]?.columnBreaks).toBeUndefined();
  });

  it('refuses a malformed rowPages or columnBreaks', () => {
    const bad = structuredClone(layout) as unknown as {
      blocks: Record<string, Record<string, unknown>>;
    };
    bad.blocks[T]!['rowPages'] = [0];
    bad.blocks[P]!['columnBreaks'] = [0];
    expect(validateLayout(bad)).toEqual([`blocks.${T}.rowPages`, `blocks.${P}.columnBreaks`]);
  });
});

describe('EXP-057 criterion 3: a block that cannot be reported at line level falls back', () => {
  it('marks a text block without lines as block level, and keeps the file at line level', () => {
    const layout = buildLayout(parseRawLayout(raw(2, [[5, 0, 2, sp(4000)]])), map, meta);
    expect(layout.granularity).toBe('line');
    expect(layout.blocks[E]?.granularity).toBe('block');
    expect(layout.blocks[E]?.lineStarts).toBeUndefined();
    expect(layout.blocks[E]).toMatchObject({ page: 2 });
    expect(layout.blocks[P]?.granularity).toBeUndefined();
    expect(validateLayout(layout)).toEqual([]);
  });

  it('says block for the whole file when no text block has a line', () => {
    const layout = buildLayout(parseRawLayout(raw(2, [])), map, meta);
    expect(layout.granularity).toBe('block');
  });

  it('gives block-level starts only, and no marks, when the compile ran at block level', () => {
    const layout = buildLayout(parseRawLayout(raw(1, [[5, 0, 2, sp(4000)]])), map, meta);
    expect(layout.granularity).toBe('block');
    expect(layout.blocks[P]).toEqual({ page: 2, y: 4000 });
    expect(layout.blocks[E]?.granularity).toBeUndefined();
  });
});
