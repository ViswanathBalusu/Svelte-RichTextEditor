/**
 * Merge and split of table cells (FE-040 criterion 3): colspan, rowspan and grid stay consistent
 * (I6, checked by the CDM validator) after every merge and split, including random ones.
 */
import { validate } from '@docedit/model/validate';
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';
import {
  type CellRect,
  cellEntries,
  mergeCellsCommand,
  mergeTableCells,
  splitCellCommand,
  splitTableCell,
} from '../src/table-span.ts';

const microtask = (run: () => void) => queueMicrotask(run);

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: microtask });
}

/** Appends a rows by cols table whose cell at (r, c) holds the text `r{r}c{c}`. */
function withTable(c: DocumentCore, rows: number, cols: number): void {
  const i = internals(c);
  const { schema } = i;
  const table = schema.nodes['table']!.create(
    { grid: Array.from({ length: cols }, () => 1440), headerRows: 0 },
    Array.from({ length: rows }, (_, r) =>
      schema.nodes['table_row']!.create(
        null,
        Array.from({ length: cols }, (_, col) =>
          schema.nodes['table_cell']!.create(
            null,
            schema.nodes['paragraph']!.create(null, schema.text(`r${r}c${col}`)),
          ),
        ),
      ),
    ),
  );
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, table));
}

function tableOf(doc: PMNode): PMNode {
  let found: PMNode | null = null;
  doc.descendants((node) => {
    if (node.type.name === 'table') found = node;
    return found === null;
  });
  if (!found) throw new Error('no table');
  return found;
}

/** Puts the caret in the first paragraph of the cell whose text starts with `marker`. */
function caretIn(c: DocumentCore, marker: string): void {
  const i = internals(c);
  let found = -1;
  i.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === 'paragraph' && node.textContent.startsWith(marker)) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error(`no cell ${marker}`);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, found)));
}

function valid(c: DocumentCore): unknown[] {
  return validate(c.getContent()).violations;
}

/** The spans of every cell as `colspan x rowspan` in the order the rows stand. */
function spansOf(table: PMNode): string[][] {
  const out: string[][] = [];
  table.forEach((row) => {
    const line: string[] = [];
    row.forEach((cell) => line.push(`${cell.attrs['colspan']}x${cell.attrs['rowspan']}`));
    out.push(line);
  });
  return out;
}

function textsOf(table: PMNode): string[][] {
  const out: string[][] = [];
  table.forEach((row) => {
    const line: string[] = [];
    row.forEach((cell) => line.push(cell.textContent));
    out.push(line);
  });
  return out;
}

function apply(c: DocumentCore, tr: ReturnType<typeof mergeTableCells> & { ok: true }): void {
  internals(c).dispatch(tr.tr);
}

describe('merge and split of table cells (FE-040 criterion 3)', () => {
  it('merges a two by two block into one cell with both spans and keeps the grid', () => {
    const c = core();
    withTable(c, 3, 3);
    caretIn(c, 'r0c0');
    const state = internals(c).state;
    const result = mergeTableCells(state, { top: 0, left: 0, bottom: 1, right: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    apply(c, result as Extract<typeof result, { ok: true }>);
    const t = tableOf(internals(c).state.doc);
    expect(spansOf(t)).toEqual([['2x2', '1x1'], ['1x1'], ['1x1', '1x1', '1x1']]);
    expect(t.attrs['grid']).toEqual([1440, 1440, 1440]);
    // The content of the merged cells is kept in reading order.
    expect(t.child(0).child(0).textContent).toBe('r0c0r0c1r1c0r1c1');
    expect(valid(c)).toEqual([]);
  });

  it('refuses a rectangle that cuts through a span, and changes nothing', () => {
    const c = core();
    withTable(c, 3, 3);
    caretIn(c, 'r0c0');
    apply(
      c,
      mergeTableCells(internals(c).state, { top: 0, left: 0, bottom: 1, right: 1 }) as Extract<
        ReturnType<typeof mergeTableCells>,
        { ok: true }
      >,
    );
    const before = internals(c).state.doc;
    caretIn(c, 'r0c0');
    const refused = mergeTableCells(internals(c).state, { top: 1, left: 1, bottom: 2, right: 2 });
    expect(refused).toEqual({ ok: false, reason: 'span-crosses' });
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('refuses a merge that would leave a row with no cell, and a single cell', () => {
    const c = core();
    withTable(c, 2, 2);
    caretIn(c, 'r0c0');
    const state = internals(c).state;
    expect(mergeTableCells(state, { top: 0, left: 0, bottom: 1, right: 1 })).toEqual({
      ok: false,
      reason: 'empty-row',
    });
    expect(mergeTableCells(state, { top: 0, left: 0, bottom: 0, right: 0 })).toEqual({
      ok: false,
      reason: 'single-cell',
    });
    expect(mergeTableCells(state, { top: 0, left: 0, bottom: 5, right: 1 })).toEqual({
      ok: false,
      reason: 'bad-rect',
    });
  });

  it('splits a merged cell back into the grid, with one empty cell per slot it covered', () => {
    const c = core();
    withTable(c, 3, 3);
    caretIn(c, 'r0c0');
    apply(
      c,
      mergeTableCells(internals(c).state, { top: 0, left: 0, bottom: 1, right: 1 }) as Extract<
        ReturnType<typeof mergeTableCells>,
        { ok: true }
      >,
    );
    const split = splitTableCell(internals(c).state);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    apply(c, split);
    const t = tableOf(internals(c).state.doc);
    expect(spansOf(t)).toEqual([
      ['1x1', '1x1', '1x1'],
      ['1x1', '1x1', '1x1'],
      ['1x1', '1x1', '1x1'],
    ]);
    expect(textsOf(t)[0]).toEqual(['r0c0r0c1r1c0r1c1', '', 'r0c2']);
    expect(valid(c)).toEqual([]);
  });

  it('refuses to split a cell that was never merged', () => {
    const c = core();
    withTable(c, 2, 2);
    caretIn(c, 'r1c1');
    expect(splitTableCell(internals(c).state)).toEqual({ ok: false, reason: 'not-merged' });
    expect(splitCellCommand()(internals(c).state)).toBe(false);
  });

  it('is unavailable as a command outside a table', () => {
    const c = core();
    const i = internals(c);
    expect(mergeCellsCommand({ top: 0, left: 0, bottom: 1, right: 1 })(i.state)).toBe(false);
    expect(mergeTableCells(i.state, { top: 0, left: 0, bottom: 1, right: 1 })).toEqual({
      ok: false,
      reason: 'not-in-table',
    });
  });

  it('runs merge and split through exec and queryCommand, keeping the grid (I6)', () => {
    const c = core();
    withTable(c, 3, 3);
    caretIn(c, 'r0c0');
    const cells = { top: 0, left: 0, bottom: 1, right: 1 };
    expect(c.queryCommand('mergeCells', { cells })).toEqual({ enabled: true, active: false });
    // Without its rectangle the merge is unavailable, and exec does nothing.
    expect(c.queryCommand('mergeCells')).toEqual({ enabled: false, active: false });
    expect(c.exec('mergeCells')).toBe(false);
    // The caret's cell is not merged yet, so split names why.
    expect(c.queryCommand('splitCell')).toEqual({
      enabled: false,
      active: false,
      reason: 'not-merged',
    });
    expect(c.commands.get()['splitCell']?.reason).toBe('not-merged');
    expect(c.exec('mergeCells', { cells })).toBe(true);
    let t = tableOf(internals(c).state.doc);
    expect(spansOf(t)).toEqual([['2x2', '1x1'], ['1x1'], ['1x1', '1x1', '1x1']]);
    expect(t.attrs['grid']).toEqual([1440, 1440, 1440]);
    expect(valid(c)).toEqual([]);
    // The caret is in the merged cell, so split is available and restores the grid.
    expect(c.queryCommand('splitCell')).toEqual({ enabled: true, active: false });
    expect(c.exec('splitCell')).toBe(true);
    t = tableOf(internals(c).state.doc);
    expect(spansOf(t)).toEqual([
      ['1x1', '1x1', '1x1'],
      ['1x1', '1x1', '1x1'],
      ['1x1', '1x1', '1x1'],
    ]);
    expect(valid(c)).toEqual([]);
  });

  it('names why a merge is refused through queryCommand, and exec changes nothing', () => {
    const c = core();
    withTable(c, 2, 2);
    caretIn(c, 'r0c0');
    const before = internals(c).state.doc;
    const reasonOf = (cells: unknown) =>
      c.queryCommand('mergeCells', { cells } as Parameters<DocumentCore['queryCommand']>[1]).reason;
    expect(reasonOf({ top: 0, left: 0, bottom: 1, right: 1 })).toBe('empty-row');
    expect(reasonOf({ top: 0, left: 0, bottom: 0, right: 0 })).toBe('single-cell');
    expect(reasonOf({ top: 0, left: 0, bottom: 5, right: 1 })).toBe('bad-rect');
    expect(reasonOf('not a rectangle')).toBe('bad-rect');
    expect(c.exec('mergeCells', { cells: { top: 0, left: 0, bottom: 1, right: 1 } })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    // Outside a table both commands say so.
    const i = internals(c);
    i.dispatch(
      i.state.tr.setSelection(TextSelection.create(i.state.doc, bodyRange(i.state.doc).start + 1)),
    );
    expect(c.queryCommand('splitCell').reason).toBe('not-in-table');
    expect(reasonOf({ top: 0, left: 0, bottom: 0, right: 1 })).toBe('not-in-table');
  });

  it('disables merge and split by canEdit in a scope the user cannot change (criterion 7)', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    withTable(c, 3, 3);
    caretIn(c, 'r0c0');
    const cells = { top: 0, left: 0, bottom: 1, right: 1 };
    expect(c.exec('mergeCells', { cells })).toBe(true);
    // The body becomes a scope this user may view and comment on only; the mode stays editing.
    c.setAccess(
      editorAccess({ rev: 2, scopes: { ...editorAccess().scopes, body: ['view', 'comment'] } }),
    );
    expect(c.canEdit('body')).toBe(false);
    const before = internals(c).state.doc;
    expect(c.queryCommand('splitCell')).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    expect(
      c.queryCommand('mergeCells', { cells: { top: 2, left: 0, bottom: 2, right: 1 } }),
    ).toEqual({ enabled: false, active: false, reason: 'no-access' });
    expect(c.exec('splitCell')).toBe(false);
    expect(c.exec('mergeCells', { cells: { top: 2, left: 0, bottom: 2, right: 1 } })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    // A read-only document says so first.
    c.setAccess(editorAccess({ rev: 3 }));
    c.setMode('view');
    expect(c.queryCommand('splitCell').reason).toBe('read-only');
    expect(c.exec('splitCell')).toBe(false);
  });

  it('keeps the grid consistent after random merges and splits (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.record({
          rows: fc.integer({ min: 2, max: 4 }),
          cols: fc.integer({ min: 2, max: 4 }),
          a: fc.nat(),
          b: fc.nat(),
          d: fc.nat(),
          e: fc.nat(),
        }),
        ({ rows, cols, a, b, d, e }) => {
          const c = core();
          withTable(c, rows, cols);
          const top = Math.min(a % rows, b % rows);
          const bottom = Math.max(a % rows, b % rows);
          const left = Math.min(d % cols, e % cols);
          const right = Math.max(d % cols, e % cols);
          caretIn(c, 'r0c0');
          const rect: CellRect = { top, left, bottom, right };
          const merged = mergeTableCells(internals(c).state, rect);
          if (!merged.ok) {
            // A refusal changes nothing, so the table is still the full grid.
            expect(valid(c)).toEqual([]);
            return;
          }
          apply(c, merged);
          expect(valid(c)).toEqual([]);
          const after = tableOf(internals(c).state.doc);
          expect(cellEntries(after, 0, cols) === null).toBe(false);
          // The caret is in the merged cell, so it can be split back.
          const split = splitTableCell(internals(c).state);
          expect(split.ok).toBe(true);
          if (!split.ok) return;
          apply(c, split);
          expect(valid(c)).toEqual([]);
          const back = tableOf(internals(c).state.doc);
          expect(back.childCount).toBe(rows);
          back.forEach((row) => expect(row.childCount).toBe(cols));
        },
      ),
      { numRuns: 80 },
    );
  });
});
