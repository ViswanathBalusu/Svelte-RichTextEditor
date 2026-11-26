/**
 * EXP-039 criterion 2 (Node.js only, sandbox): the continuation rows of a row taller than a page
 * are compiled, and the PDF text equals the row's text, with the header rows repeating on every
 * page the table continues on. The heights come from the editor's layout (owner decision 114),
 * imported by path because this package does not depend on it; tests may.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import {
  firstFitBreaker,
  fixedWidthMeasurer,
  measureTables,
  type BreakOpportunities,
  type ItemProviders,
} from '../../layout/src/index.ts';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const LINES = 150;

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};
const providers: ItemProviders = {
  // A line is 1.4 em high, taller than the class sets 11 pt text: the editor's measurer is given
  // the metrics of the font, and a stand-in must not say a part fits when LaTeX sets it taller.
  measurer: fixedWidthMeasurer({ ascent: 1, descent: 0.4 }),
  breaks: afterSpace,
  lineBreaker: firstFitBreaker,
};

const row = (cells: J[][]): J => ({
  type: 'table_row',
  attrs: { id: nid('r') },
  content: cells.map((content) => ({ type: 'table_cell', attrs: { id: nid('c') }, content })),
});

describe.skipIf(!ready)('EXP-039 criterion 2: continuation rows in the compiled PDF', () => {
  it('keeps the text of the tall row and repeats the header rows on every later page', async () => {
    const table: J = {
      type: 'table',
      attrs: { id: nid('t'), grid: [4000, 4000], headerRows: 1 },
      content: [
        row([[para('HEADROW')], [para('HEADSIDE')]]),
        row([
          Array.from({ length: LINES }, (_, i) => para(`Entry number ${i + 1} ends`)),
          [para('SIDENOTE')],
        ]),
      ],
    };
    const envelope = doc([table]);
    const measure = measureTables(envelope as never, providers);
    const c = await convertAndCompile(envelope, {
      profile: 'preview',
      title: 'table-row-split',
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      tableMeasure: measure,
    } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
    expect(c.bundle.diagnostics.map((d) => d.code)).toContain('row_split');
    const text = pdfText(c.compile.pdf);
    if (text === null) throw new Error('pdftotext is not installed or failed');
    const pages = text.split('\f');
    if (pages[pages.length - 1]!.trim() === '') pages.pop();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    // The text of the row: every entry once, in order, and the other cell's text once.
    const entries = [...text.matchAll(/Entry number (\d+) ends/g)].map((m) => Number(m[1]));
    expect(entries).toEqual(Array.from({ length: LINES }, (_, i) => i + 1));
    expect(text.split('SIDENOTE').length - 1).toBe(1);
    // The header row is at the top of every page after the first.
    for (const p of pages.slice(1)) {
      const first = p.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
      expect(first).toContain('HEADROW');
    }
  }, 300_000);
});
