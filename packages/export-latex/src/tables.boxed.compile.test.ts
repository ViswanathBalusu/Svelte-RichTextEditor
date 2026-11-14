/**
 * EXP-040 criterion 3, checked on the compiled PDF (Node.js only, sandbox): the paragraphs, a figure
 * and an equation of a table cell all appear in the PDF text of a boxed table in a two-column section.
 *
 * The figure has no picture (its placeholder `[figure: ...]` is what the PDF shows), and the
 * equation is one the math gate refuses (its placeholder `[equation]` is what the PDF shows), so the
 * test does not depend on a picture file or on a typeset formula. A typeset formula is not checked
 * here; see the story's Notes.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const PS_TWO_COLUMNS = { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } };
const TWO_COLUMN_BREAK = { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2' } };
const TWO_COLUMNS = { pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1' } }, PS_TWO_COLUMNS] };

describe.skipIf(!ready)(
  'EXP-040 criterion 3: cell paragraphs, figures and equations appear in a boxed table',
  () => {
    it('prints the text of every block of a boxed table cell in the PDF', async () => {
      const cell: J[] = [
        para('CELLPARA', { id: nid('p') }),
        { type: 'figure', attrs: { id: nid('f'), width: 1440, height: 1440, alt: 'FIGALT' } },
        { type: 'equation_block', attrs: { id: nid('e'), latex: '\\rlap{x}' } },
      ];
      const tbl: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [4320] },
        content: [
          {
            type: 'table_row',
            attrs: { id: nid('r') },
            content: [{ type: 'table_cell', attrs: { id: nid('c') }, content: cell }],
          },
        ],
      };
      const c = await convertAndCompile(doc([TWO_COLUMN_BREAK, tbl], TWO_COLUMNS), {
        profile: 'preview',
        title: 'boxed-table-cells',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      expect(c.bundle.files['main.tex']).toContain('\\DEboxtbl{');
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      expect(text).toContain('CELLPARA');
      expect(text).toContain('[figure: FIGALT]');
      expect(text).toContain('[equation]');
    }, 300_000);
  },
);
