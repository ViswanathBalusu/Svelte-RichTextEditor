/**
 * EXP-003 criteria 1 and 5 (lane w2, 2026-11-26), with the row measure of EXP-039 now built. One
 * document holds all four occurrences the criterion names: a table row taller than a page, a table
 * in a multi-column section, a character no loaded font covers, and an image without alternative
 * text. The shared preflight, given the measure the worker computes, returns one warning for each,
 * with the block identifier and a code (criterion 1). The job built from the same document carries
 * the same warning for each of them (criterion 5): for the three the preflight and the converter
 * both report, the same code and block; for the row, the preflight's `row_taller_than_page` is the
 * job's `row_split` (the converter has acted on it), naming the same table and the same row. No
 * compile here.
 */
import { preflight, type FontManifest } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../../../packages/export-latex/test/docs.ts';
import { buildBundle, measureTablesOf } from '../src/bundle-io.ts';
import { TEST_FONTS } from './fonts.ts';

/** The test manifest with the Basic Latin block as the coverage of every face. */
function covered(): FontManifest {
  const range = [[0x20, 0x7e]] as const;
  const withRange = <T extends object>(f: T) => ({ ...f, coverage: range });
  return {
    ...TEST_FONTS,
    families: TEST_FONTS.families.map((f) => ({
      ...f,
      regular: withRange(f.regular),
      bold: withRange(f.bold),
      italic: withRange(f.italic),
      boldItalic: withRange(f.boldItalic),
    })),
    math: withRange(TEST_FONTS.math),
  } as FontManifest;
}

const row = (cells: J[][]): J => ({
  type: 'table_row',
  attrs: { id: nid('r') },
  content: cells.map((content) => ({ type: 'table_cell', attrs: { id: nid('c') }, content })),
});

const tableOf = (id: string, lines: number): J => ({
  type: 'table',
  attrs: { id, grid: [4000, 4000], headerRows: 1 },
  content: [
    row([[para('Head')], [para('Side')]]),
    row([Array.from({ length: lines }, (_, i) => para(`Line ${i + 1}`)), [para('Note')]]),
  ],
});

const TALL = nid('t');
const NARROW = nid('t');
const GLYPHS = nid('p');
const PICTURE = nid('f');

function fixture() {
  const envelope = doc(
    [
      tableOf(TALL, 300),
      { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2' } },
      tableOf(NARROW, 2),
      {
        type: 'paragraph',
        attrs: { id: GLYPHS },
        content: [{ type: 'text', text: 'Café' }],
      },
      {
        type: 'figure',
        attrs: { id: PICTURE, asset: 'pic1', width: 1440, height: 1440 },
      },
    ],
    {
      pageSetups: [
        { type: 'page_setup', attrs: { id: 'ps1' } },
        { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } },
      ],
    },
  );
  return envelope;
}

describe('EXP-003 criterion 1: one warning for each occurrence, with the block and a code', () => {
  it('reports the row, the table in columns, the character and the picture, once each', async () => {
    const envelope = fixture();
    const measure = await measureTablesOf(envelope);
    expect(measure).not.toBeNull();
    const ws = preflight(envelope, covered(), measure ?? undefined);
    const summary = ws.map((w) => `${w.code} ${w.blockId}`).sort();
    expect(summary).toEqual(
      [
        `row_taller_than_page ${TALL}`,
        `table_cannot_span_pages ${NARROW}`,
        `glyph_missing ${GLYPHS}`,
        `image_without_alt ${PICTURE}`,
      ].sort(),
    );
    const row = ws.find((w) => w.code === 'row_taller_than_page')!;
    expect(row.message).toContain('row 2');
  });
});

describe('EXP-003 criterion 5: the job carries the same warnings', () => {
  it('has a warning for each occurrence the preflight reported, with the same block', async () => {
    const envelope = fixture();
    const fonts = covered();
    const measure = await measureTablesOf(envelope);
    const pre = preflight(envelope, fonts, measure ?? undefined);
    const bundle = await buildBundle(envelope, { fonts });
    const job = bundle.diagnostics;
    // The three the converter also reports under the preflight's own code.
    for (const code of ['table_cannot_span_pages', 'glyph_missing', 'image_without_alt'] as const) {
      const want = pre.filter((w) => w.code === code).map((w) => w.blockId);
      expect(want.length, code).toBe(1);
      expect(
        job.filter((d) => d.code === code).map((d) => d.blockId),
        code,
      ).toEqual(want);
    }
    // The row the preflight said would be split is the row the job split: same table, same row.
    const planned = pre.find((w) => w.code === 'row_taller_than_page')!;
    const split = job.filter((d) => d.code === 'row_split');
    expect(split).toHaveLength(1);
    expect(split[0]!.blockId).toBe(planned.blockId);
    expect(split[0]!.message).toContain(planned.message.match(/row \d+ of table \S+/)![0]);
    // And each is carried once, not twice.
    expect(job.filter((d) => d.code === 'row_taller_than_page')).toEqual([]);
  });

  it('carries no row warning in the job when the preflight reported none', async () => {
    const envelope = doc([tableOf(TALL, 3), para('Text.')]);
    const measure = await measureTablesOf(envelope);
    expect(preflight(envelope, TEST_FONTS, measure ?? undefined)).toEqual([]);
    const bundle = await buildBundle(envelope, { fonts: TEST_FONTS });
    expect(bundle.diagnostics.map((d) => d.code)).not.toContain('row_split');
  });
});
