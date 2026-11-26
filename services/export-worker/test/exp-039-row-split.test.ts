/**
 * EXP-039: the worker measures the rows of a document's tables with the editor's own page layout
 * (owner decision 114) before it calls the converter, so that a row taller than a page is split in
 * the job as it is in the editor's preflight. No compile here; the compiled PDF is checked in
 * `packages/export-latex/src/tables.split.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../../../packages/export-latex/test/docs.ts';
import { buildBundle } from '../src/bundle-io.ts';
import { TEST_FONTS } from './fonts.ts';

const row = (cells: J[][]): J => ({
  type: 'table_row',
  attrs: { id: nid('r') },
  content: cells.map((content) => ({ type: 'table_cell', attrs: { id: nid('c') }, content })),
});

const table = (lines: number): J => ({
  type: 'table',
  attrs: { id: nid('t'), grid: [4000, 4000], headerRows: 1 },
  content: [
    row([[para('Head')], [para('Side')]]),
    row([Array.from({ length: lines }, (_, i) => para(`Line ${i + 1}`)), [para('Note')]]),
  ],
});

describe('EXP-039 the worker gives the converter the layout heights', () => {
  it('splits a row taller than a page and warns', async () => {
    const bundle = await buildBundle(doc([table(300)]), { fonts: TEST_FONTS });
    const w = bundle.diagnostics.filter((d) => d.code === 'row_split');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('row 2');
  });

  it('leaves a document whose rows fit as it was, and a document without a table', async () => {
    const small = await buildBundle(doc([table(3)]), { fonts: TEST_FONTS });
    expect(small.diagnostics.map((d) => d.code)).not.toContain('row_split');
    const none = await buildBundle(doc([para('Text only.')]), { fonts: TEST_FONTS });
    expect(none.diagnostics.map((d) => d.code)).not.toContain('row_split');
  });

  it('takes the measure the caller passes in place of its own', async () => {
    const bundle = await buildBundle(doc([table(300)]), {
      fonts: TEST_FONTS,
      tableMeasure: { engine: 'caller', measurer: 'caller', tables: [] },
    });
    expect(bundle.diagnostics.map((d) => d.code)).not.toContain('row_split');
  });
});
