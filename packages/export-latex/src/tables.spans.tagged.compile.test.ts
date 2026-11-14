/**
 * EXP-041 criterion 4, checked on the compiled PDF (Node.js only, sandbox): with tagging on, the
 * spans of a table are recorded in its structure tree.
 *
 * The structure tree is read from the PDF's flate streams (Node.js zlib); the object streams hold
 * the structure elements. A column span is recorded: tagpdf writes `/ColSpan 2` for the `\multicolumn`
 * that `\DEcolspan` wraps. A row span is recorded through `\DErowspan`, which sets tagpdf's
 * `table/multirow` key (latex-lab table test phase, enabled by the preamble's testphase={table}).
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const OPTIONS = {
  profile: 'preview',
  instant: '2026-11-06T10:00:00.000Z',
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;

/** The PDF's objects as text: the raw bytes plus every flate stream that inflates. */
function objectText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts: string[] = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // not a flate stream
    }
  }
  return parts.join('\n');
}

function cell(text: string, attrs: J = {}): J {
  return { type: 'table_cell', attrs: { id: nid('c'), ...attrs }, content: [para(text)] };
}
function row(...cells: J[]): J {
  return { type: 'table_row', attrs: { id: nid('r') }, content: cells };
}

/** A table whose first cell spans two columns and two rows. */
function spanTable(): J {
  return {
    type: 'table',
    attrs: { id: nid('t'), width: { type: 'auto' }, grid: [1440, 1440, 1440] },
    content: [
      row(cell('Block', { colspan: 2, rowspan: 2 }), cell('Right top')),
      row(cell('Right bottom')),
      row(cell('A'), cell('B'), cell('C')),
    ],
  } as unknown as J;
}

describe.skipIf(!ready)(
  'EXP-041 criterion 4: the spans of a tagged table are in its structure tree',
  () => {
    it('records a column span as /ColSpan 2 in the structure tree', async () => {
      const c = await convertAndCompile(doc([spanTable()]), OPTIONS as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      expect(objectText(c.compile.pdf)).toMatch(/\/ColSpan 2\b/);
    }, 300_000);

    // EXP-041 criterion 4 (lane V-EXP-033-048, round 11): \DErowspan{rows}{content} sets tagpdf's
    // table/multirow key on the cell (testphase table), so the cell carries /RowSpan 2.
    it('records a row span as /RowSpan 2 in the structure tree', async () => {
      const c = await convertAndCompile(doc([spanTable()]), OPTIONS as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      expect(objectText(c.compile.pdf)).toMatch(/\/RowSpan 2\b/);
    }, 300_000);
  },
);
