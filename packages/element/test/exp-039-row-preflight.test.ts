/**
 * EXP-039 criterion 4: the editor's preflight reports a table row taller than a page before the
 * export, from the editor's own page layout (owner decision 114), with the same shared function the
 * converter calls. The layout is the real engine over a fixed-width measurer (the canvas is not
 * there in Node.js tests); the default measure gives none without a canvas, so no row is reported.
 */
import { preflight } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../../export-latex/test/docs.ts';
import { firstFitBreaker, fixedWidthMeasurer, type ItemProviders } from '../../layout/src/index.ts';
import { measureTables } from '../../layout/src/table-measure.ts';
import { exportPreflight } from '../src/export-preflight.ts';

const providers: ItemProviders = {
  measurer: fixedWidthMeasurer(),
  breaks: { opportunities: () => [] },
  lineBreaker: firstFitBreaker,
};

const row = (cells: J[][]): J => ({
  type: 'table_row',
  attrs: { id: nid('r') },
  content: cells.map((content) => ({ type: 'table_cell', attrs: { id: nid('c') }, content })),
});

const tableId = nid('t');
const envelope: CdmEnvelope = doc([
  {
    type: 'table',
    attrs: { id: tableId, grid: [4000, 4000], headerRows: 1 },
    content: [
      row([[para('Head')], [para('Side')]]),
      row([Array.from({ length: 120 }, (_, i) => para(`Line ${i + 1}`)), [para('Note')]]),
    ],
  },
]);

describe('EXP-039 the editor preflight reports a row taller than a page', () => {
  it('names the table and the row, with the measure of the layout', async () => {
    const found = await exportPreflight(
      'pdf',
      {},
      {
        content: () => envelope,
        measure: (content) => measureTables(content as never, providers),
      },
    );
    const row = found.filter((d) => d.code === 'row_taller_than_page');
    expect(row).toHaveLength(1);
    expect(row[0]!.blockId).toBe(tableId);
    expect(row[0]!.severity).toBe('warning');
    expect(row[0]!.message).toContain('row 2');
  });

  it('gives exactly what the shared function gives the converter', async () => {
    const measure = measureTables(envelope as never, providers);
    const editor = await exportPreflight(
      'pdf',
      {},
      { content: () => envelope, measure: () => measure },
    );
    expect(editor.map((d) => [d.code, d.blockId, d.message])).toEqual(
      preflight(envelope, undefined, measure).map((w) => [w.code, w.blockId, w.message]),
    );
  });

  it('reports no row without a measure, and when the measure cannot be made', async () => {
    expect(await exportPreflight('pdf', {}, { content: () => envelope })).toEqual([]);
    const failing = await exportPreflight(
      'pdf',
      {},
      {
        content: () => envelope,
        measure: () => {
          throw new Error('no canvas');
        },
      },
    );
    expect(failing).toEqual([]);
  });
});
