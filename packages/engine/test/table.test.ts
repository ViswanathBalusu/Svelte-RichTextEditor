/**
 * Table structure commands (FE-040): rows and columns, the header block, the 63-column limit (I7),
 * Tab and Shift+Tab between cells, the scope guard, and the table invariants (I6) after every
 * operation. The document is the spike document of S1 with one table appended to the body.
 */
import { validate } from '@docedit/model/validate';
import fc from 'fast-check';
import { EditorState as PlainState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { press } from '../src/keys.ts';
import { trimPlugin } from '../src/trim.ts';
import {
  insertTable,
  isRegular,
  locateCell,
  MAX_TABLE_COLUMNS,
  moveToCell,
  tableCommand,
  tableRefusal,
  type TableOp,
} from '../src/table.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);

interface TableSpec {
  rows: number;
  cols: number;
  headerRows?: number;
  width?: number;
}

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: microtask });
}

/** Appends a table with `rows` by `cols` cells to the body; each cell says where it stands. */
function withTable(c: DocumentCore, spec: TableSpec): void {
  const i = internals(c);
  const { schema } = i;
  const table = schema.nodes['table']!.create(
    {
      grid: Array.from({ length: spec.cols }, () => spec.width ?? 1440),
      headerRows: spec.headerRows ?? 0,
    },
    Array.from({ length: spec.rows }, (_, r) =>
      schema.nodes['table_row']!.create(
        null,
        Array.from({ length: spec.cols }, (_, col) =>
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

/** The table node: the last block of the body after `withTable`. */
function tableOf(doc: PMNode): PMNode {
  let found: PMNode | null = null;
  doc.descendants((node) => {
    if (node.type.name === 'table') found = node;
    return found === null;
  });
  if (!found) throw new Error('no table');
  return found;
}

/** The position inside the first paragraph of the cell at (row, col). */
function textPosOf(doc: PMNode, row: number, col: number): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === 'table_cell') {
      const r = doc.resolve(pos);
      if (r.index(r.depth - 1) === row && r.index(r.depth) === col) found = pos + 2;
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`no cell ${row},${col}`);
  return found;
}

function caretAt(c: DocumentCore, row: number, col: number): void {
  const i = internals(c);
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, textPosOf(i.state.doc, row, col))),
  );
}

function run(c: DocumentCore, op: TableOp): boolean {
  const i = internals(c);
  return tableCommand(op)(i.state, i.dispatch);
}

function texts(table: PMNode): string[][] {
  const out: string[][] = [];
  table.forEach((row) => {
    const line: string[] = [];
    row.forEach((cell) => line.push(cell.textContent));
    out.push(line);
  });
  return out;
}

function allIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type.name.startsWith('table') && typeof node.attrs['id'] === 'string')
      ids.push(node.attrs['id']);
    return true;
  });
  return ids;
}

const valid = (c: DocumentCore) => validate(c.getContent()).violations;

describe('table rows (FE-040)', () => {
  it('inserts a row above or below with one empty cell per column and fresh identifiers', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    caretAt(c, 0, 0);
    expect(run(c, 'insertRowBelow')).toBe(true);
    let t = tableOf(internals(c).state.doc);
    expect(texts(t)).toEqual([
      ['r0c0', 'r0c1'],
      ['', ''],
      ['r1c0', 'r1c1'],
    ]);
    expect(isRegular(t)).toBe(true);

    caretAt(c, 0, 0);
    expect(run(c, 'insertRowAbove')).toBe(true);
    t = tableOf(internals(c).state.doc);
    expect(texts(t)).toEqual([
      ['', ''],
      ['r0c0', 'r0c1'],
      ['', ''],
      ['r1c0', 'r1c1'],
    ]);

    const ids = allIds(internals(c).state.doc);
    expect(ids.every((id) => id.length === 16)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(valid(c)).toEqual([]);
  });

  it('deletes a row, but not the only row of a table', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    caretAt(c, 0, 1);
    expect(run(c, 'deleteRow')).toBe(true);
    expect(texts(tableOf(internals(c).state.doc))).toEqual([['r1c0', 'r1c1']]);
    expect(run(c, 'deleteRow')).toBe(false);
    expect(valid(c)).toEqual([]);
  });

  it('keeps the header block together when rows are inserted or deleted among header rows', () => {
    const c = core();
    withTable(c, { rows: 3, cols: 1, headerRows: 1 });
    caretAt(c, 0, 0);
    expect(run(c, 'insertRowAbove')).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['headerRows']).toBe(2);
    caretAt(c, 2, 0);
    expect(run(c, 'insertRowBelow')).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['headerRows']).toBe(2);
    caretAt(c, 0, 0);
    expect(run(c, 'deleteRow')).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['headerRows']).toBe(1);
    expect(valid(c)).toEqual([]);
  });
});

describe('table columns (FE-040, I6, I7)', () => {
  it('inserts a column with the width of its neighbour and a cell in every row', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2, width: 1000 });
    caretAt(c, 1, 0);
    expect(run(c, 'insertColumnLeft')).toBe(true);
    const t = tableOf(internals(c).state.doc);
    expect(texts(t)).toEqual([
      ['', 'r0c0', 'r0c1'],
      ['', 'r1c0', 'r1c1'],
    ]);
    expect(t.attrs['grid']).toEqual([1000, 1000, 1000]);
    expect(isRegular(t)).toBe(true);
    expect(valid(c)).toEqual([]);
  });

  it('inserts a column to the right and deletes a column, but not the only column', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    caretAt(c, 0, 1);
    expect(run(c, 'insertColumnRight')).toBe(true);
    expect(texts(tableOf(internals(c).state.doc))).toEqual([
      ['r0c0', 'r0c1', ''],
      ['r1c0', 'r1c1', ''],
    ]);
    caretAt(c, 0, 0);
    expect(run(c, 'deleteColumn')).toBe(true);
    expect(texts(tableOf(internals(c).state.doc))).toEqual([
      ['r0c1', ''],
      ['r1c1', ''],
    ]);
    caretAt(c, 0, 0);
    expect(run(c, 'deleteColumn')).toBe(true);
    caretAt(c, 0, 0);
    expect(run(c, 'deleteColumn')).toBe(false);
    expect(valid(c)).toEqual([]);
  });

  it('is unavailable with a reason when a table has 63 columns (I7)', async () => {
    const c = core();
    withTable(c, { rows: 1, cols: MAX_TABLE_COLUMNS });
    caretAt(c, 0, 0);
    const limit = { enabled: false, active: false, reason: 'column-limit' };
    // The core's registry answers with the reason, for both directions.
    expect(c.queryCommand('insertColumnRight')).toEqual(limit);
    expect(c.queryCommand('insertColumnLeft')).toEqual(limit);
    // The published command view carries the same state.
    await Promise.resolve();
    expect(c.commands.get().insertColumnRight).toEqual(limit);
    // Running it changes nothing; rows can still be added.
    expect(c.exec('insertColumnRight')).toBe(false);
    expect(run(c, 'insertColumnLeft')).toBe(false);
    expect(tableOf(internals(c).state.doc).attrs['grid']).toHaveLength(MAX_TABLE_COLUMNS);
    expect(c.queryCommand('insertRowBelow')).toEqual({ enabled: true, active: false });
  });

  it('allows a 62-column table to reach 63 columns and no more', () => {
    const c = core();
    withTable(c, { rows: 1, cols: MAX_TABLE_COLUMNS - 1 });
    caretAt(c, 0, 0);
    expect(c.queryCommand('insertColumnRight')).toEqual({ enabled: true, active: false });
    expect(c.exec('insertColumnRight')).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['grid']).toHaveLength(MAX_TABLE_COLUMNS);
    caretAt(c, 0, 0);
    expect(c.queryCommand('insertColumnRight').reason).toBe('column-limit');
    expect(run(c, 'insertColumnRight')).toBe(false);
    expect(valid(c)).toEqual([]);
  });
});

describe('the reason a table command is unavailable (FE-040)', () => {
  it('names the caret outside a table, the last row and the last column', () => {
    const c = core();
    expect(c.queryCommand('deleteTable')).toEqual({
      enabled: false,
      active: false,
      reason: 'not-in-table',
    });
    withTable(c, { rows: 1, cols: 1 });
    caretAt(c, 0, 0);
    expect(c.queryCommand('deleteRow').reason).toBe('last-row');
    expect(c.queryCommand('deleteColumn').reason).toBe('last-column');
    expect(c.queryCommand('deleteTable')).toEqual({ enabled: true, active: false });
  });

  it('names a table with merged cells', () => {
    const c = core();
    withTable(c, { rows: 1, cols: 2 });
    const i = internals(c);
    // Make the first cell span both columns and drop the second: a merged, I6-valid row.
    const tablePos = textPosOf(i.state.doc, 0, 0) - 4;
    const table = i.state.doc.nodeAt(tablePos)!;
    const first = table.child(0).child(0);
    const merged = i.schema.nodes['table_row']!.create(table.child(0).attrs, [
      first.type.create({ ...first.attrs, colspan: 2 }, first.content),
    ]);
    i.dispatch(
      i.state.tr.replaceWith(tablePos + 1, tablePos + 1 + table.child(0).nodeSize, merged),
    );
    caretAt(c, 0, 0);
    expect(isRegular(tableOf(internals(c).state.doc))).toBe(false);
    expect(c.queryCommand('insertColumnRight').reason).toBe('merged-cells');
  });

  it('names a scope the user cannot change, and a read-only document', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    caretAt(c, 0, 0);
    const i = internals(c);
    const locked = PlainState.create({
      doc: i.state.doc,
      selection: i.state.selection,
      plugins: [trimPlugin(() => false)],
    });
    expect(tableRefusal(locked, 'insertRowBelow')).toBe('no-access');
    c.setMode('view');
    expect(c.queryCommand('insertRowBelow')).toEqual({
      enabled: false,
      active: false,
      reason: 'read-only',
    });
    expect(c.exec('insertRowBelow')).toBe(false);
  });
});

describe('deleting a table and inserting one (FE-040)', () => {
  it('leaves an empty paragraph when the table is the only block of the body', () => {
    const c = core();
    const i = internals(c);
    // Remove the spike body's paragraphs first, so that the table is the only block.
    const body = bodyRange(i.state.doc);
    i.dispatch(i.state.tr.delete(body.start, body.end));
    withTable(c, { rows: 1, cols: 1 });
    caretAt(c, 0, 0);
    expect(run(c, 'deleteTable')).toBe(true);
    const last = internals(c).state.doc.lastChild!.lastChild!;
    expect(last.type.name).toBe('paragraph');
    expect(valid(c)).toEqual([]);
  });

  it('removes a table between other paragraphs', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    caretAt(c, 0, 0);
    expect(run(c, 'deleteTable')).toBe(true);
    let found = false;
    internals(c).state.doc.descendants((n) => {
      if (n.type.name === 'table') found = true;
      return !found;
    });
    expect(found).toBe(false);
    expect(valid(c)).toEqual([]);
  });

  it('refuses to insert a table inside a cell (I10)', () => {
    const c = core();
    withTable(c, { rows: 1, cols: 1 });
    caretAt(c, 0, 0);
    expect(insertTable([1440, 1440], 2)(internals(c).state, undefined)).toBe(false);
    expect(texts(tableOf(internals(c).state.doc))).toEqual([['r0c0']]);
  });

  it('inserts a table in a body paragraph, and refuses more than 63 columns (I7)', () => {
    const c = core();
    const i = internals(c);
    const body = bodyRange(i.state.doc);
    // The body's first block is a paragraph of the spike document, so its first text position is
    // inside the body and outside any table.
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, body.start + 1)));
    expect(insertTable(new Array(MAX_TABLE_COLUMNS + 1).fill(1440), 1)(internals(c).state)).toBe(
      false,
    );
    expect(insertTable([1440, 1440], 2)(internals(c).state, internals(c).dispatch)).toBe(true);
    const inserted = tableOf(internals(c).state.doc);
    // The new table, its rows and its cells all have fresh identifiers from the same transaction.
    expect(inserted.attrs['id']).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(new Set(allIds(internals(c).state.doc)).size).toBe(
      allIds(internals(c).state.doc).length,
    );
    expect(texts(inserted)).toEqual([
      ['', ''],
      ['', ''],
    ]);
    // The caret moves into the first cell.
    expect(locateCell(internals(c).state.selection.$from)).not.toBeNull();
    expect(valid(c)).toEqual([]);
  });
});

describe('moving between cells (FE-040)', () => {
  it('moves the caret with Tab and Shift+Tab and lets the last Tab fall through', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    const i = internals(c);
    caretAt(c, 0, 0);
    expect(press(i.schema, 'Tab', internals(c).state, internals(c).dispatch)).toBe(true);
    expect(internals(c).state.selection.$from.parent.textContent).toBe('r0c1');
    expect(press(i.schema, 'Tab', internals(c).state, internals(c).dispatch)).toBe(true);
    expect(internals(c).state.selection.$from.parent.textContent).toBe('r1c0');
    expect(press(i.schema, 'Shift-Tab', internals(c).state, internals(c).dispatch)).toBe(true);
    expect(internals(c).state.selection.$from.parent.textContent).toBe('r0c1');
    caretAt(c, 1, 1);
    expect(moveToCell(1)(internals(c).state)).toBe(false);
  });

  it('does nothing outside a table', () => {
    const c = core();
    const i = internals(c);
    expect(moveToCell(1)(i.state)).toBe(false);
  });
});

describe('scope guard (FE-040)', () => {
  it('disables every table command in a scope the user cannot change', () => {
    const c = core();
    withTable(c, { rows: 2, cols: 2 });
    caretAt(c, 0, 0);
    const i = internals(c);
    const locked = PlainState.create({
      doc: i.state.doc,
      selection: i.state.selection,
      plugins: [trimPlugin(() => false)],
    });
    const ops: TableOp[] = [
      'insertRowAbove',
      'insertRowBelow',
      'insertColumnLeft',
      'insertColumnRight',
      'deleteRow',
      'deleteColumn',
      'deleteTable',
    ];
    for (const op of ops) expect(tableCommand(op)(locked)).toBe(false);
    expect(insertTable([1440], 1)(locked)).toBe(false);
  });
});

describe('table invariants under random operations (FE-040, I6)', () => {
  const OPS: TableOp[] = [
    'insertRowAbove',
    'insertRowBelow',
    'insertColumnLeft',
    'insertColumnRight',
    'deleteRow',
    'deleteColumn',
  ];

  it('keeps the grid, the rows and the identifiers consistent after any sequence of operations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(
          fc.record({ op: fc.integer({ min: 0, max: OPS.length - 1 }), r: fc.nat(), c: fc.nat() }),
          { minLength: 1, maxLength: 12 },
        ),
        (rows, cols, steps) => {
          const d = core();
          withTable(d, { rows, cols });
          for (const step of steps) {
            const t = tableOf(internals(d).state.doc);
            const r = step.r % t.childCount;
            const k = step.c % t.child(r).childCount;
            caretAt(d, r, k);
            run(d, OPS[step.op]!);
            const now = tableOf(internals(d).state.doc);
            const grid = now.attrs['grid'] as number[];
            expect(isRegular(now)).toBe(true);
            now.forEach((row) => expect(row.childCount).toBe(grid.length));
            expect(now.attrs['headerRows'] as number).toBeLessThanOrEqual(now.childCount);
            const ids = allIds(internals(d).state.doc);
            expect(new Set(ids).size).toBe(ids.length);
            expect(valid(d)).toEqual([]);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
