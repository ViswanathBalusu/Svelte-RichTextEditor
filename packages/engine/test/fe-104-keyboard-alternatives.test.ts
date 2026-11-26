/**
 * FE-104: the keyboard and dialog forms of dragging. `setTableSize` sets the column widths and the
 * caret's row height with the values a drag would store (criterion 1), and `moveBlockUp` and
 * `moveBlockDown` change the place of the blocks at the selection (criterion 3). Both are one
 * transaction, so one undo step, and both keep the document valid and every identifier unique.
 */
import { validate } from '@docedit/model/validate';
import { closeHistory } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { locateCell } from '../src/table.ts';

const microtask = (run: () => void) => queueMicrotask(run);
const core = (): DocumentCore => new DocumentCore({ doc: spikeDocument(), schedule: microtask });
const valid = (c: DocumentCore) => validate(c.getContent()).violations;

function withTable(c: DocumentCore, rows: number, cols: number): void {
  const i = internals(c);
  const { schema } = i;
  const table = schema.nodes['table']!.create(
    { grid: Array.from({ length: cols }, () => 1440) },
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
  // The table's insertion is its own undo step, apart from what the test does next.
  i.dispatch(closeHistory(i.state.tr));
}

function tableOf(doc: PMNode): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table') found = { node, pos };
    return found === null;
  });
  if (!found) throw new Error('no table');
  return found;
}

function caretInCell(c: DocumentCore, row: number, col: number): void {
  const i = internals(c);
  const { node, pos } = tableOf(i.state.doc);
  let at = pos + 1;
  for (let r = 0; r < row; r++) at += node.child(r).nodeSize;
  at += 1;
  for (let k = 0; k < col; k++) at += node.child(row).child(k).nodeSize;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 2)));
}

/** The text of every body block, in order: a table is its cell text joined with `|`. */
function bodyTexts(c: DocumentCore): string[] {
  const out: string[] = [];
  const body = internals(c).state.doc.lastChild!;
  body.forEach((block) => out.push(block.textContent));
  return out;
}

function ids(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    const id = n.attrs['id'];
    if (typeof id === 'string') out.push(id);
    return true;
  });
  return out;
}

/** Puts the caret in the body block `index`. */
function caretInBlock(c: DocumentCore, index: number): void {
  const i = internals(c);
  const body = bodyRange(i.state.doc);
  let at = body.start;
  for (let k = 0; k < index; k++) at += i.state.doc.lastChild!.child(k).nodeSize;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 1)));
}

describe('FE-104 criterion 1: column widths and row height by command', () => {
  it('sets every column width and the row height, as one undo step', () => {
    const c = core();
    withTable(c, 2, 3);
    caretInCell(c, 1, 0);
    const before = tableOf(internals(c).state.doc).node;
    expect(
      c.run('setTableSize', { tableSize: { columnWidths: [1000, 2000, 3000], rowHeight: 700 } }),
    ).toBe(true);
    const { node } = tableOf(internals(c).state.doc);
    expect(node.attrs['grid']).toEqual([1000, 2000, 3000]);
    // The caret's row has the height, and holds at least that; the other row is as it was.
    expect(node.child(1).attrs['height']).toBe(700);
    expect(node.child(1).attrs['heightRule']).toBe('atLeast');
    expect(node.child(0).attrs['height']).toBeNull();
    expect(valid(c)).toEqual([]);
    c.run('undo');
    expect(tableOf(internals(c).state.doc).node.eq(before)).toBe(true);
  });

  it('returns a row to its natural height with null', () => {
    const c = core();
    withTable(c, 1, 2);
    caretInCell(c, 0, 0);
    c.run('setTableSize', { tableSize: { rowHeight: 500 } });
    expect(tableOf(internals(c).state.doc).node.child(0).attrs['height']).toBe(500);
    c.run('setTableSize', { tableSize: { rowHeight: null } });
    const row = tableOf(internals(c).state.doc).node.child(0);
    expect(row.attrs['height']).toBeNull();
    expect(row.attrs['heightRule']).toBe('auto');
  });

  it('refuses a wrong number of widths and values outside the CDM range, and changes nothing', () => {
    const c = core();
    withTable(c, 1, 2);
    caretInCell(c, 0, 0);
    const before = internals(c).state.doc;
    expect(c.queryCommand('setTableSize', { tableSize: { columnWidths: [1000] } }).reason).toBe(
      'no-column',
    );
    expect(c.queryCommand('setTableSize', { tableSize: { columnWidths: [1000, 0] } }).reason).toBe(
      'bad-size',
    );
    expect(
      c.queryCommand('setTableSize', { tableSize: { columnWidths: [1000, 40000] } }).reason,
    ).toBe('bad-size');
    expect(c.queryCommand('setTableSize', { tableSize: { rowHeight: 1.5 } }).reason).toBe(
      'bad-size',
    );
    expect(c.run('setTableSize', { tableSize: { columnWidths: [1000] } })).toBe(false);
    expect(internals(c).state.doc).toBe(before);
  });

  it('is unavailable outside a table and in a read-only document', () => {
    const c = core();
    expect(c.queryCommand('setTableSize').reason).toBe('not-in-table');
    expect(c.queryCommand('setTableSize', { tableSize: { rowHeight: 600 } }).reason).toBe(
      'not-in-table',
    );
    withTable(c, 1, 1);
    caretInCell(c, 0, 0);
    expect(c.queryCommand('setTableSize').enabled).toBe(true);
    c.setMode('view');
    expect(c.queryCommand('setTableSize', { tableSize: { rowHeight: 600 } }).reason).toBe(
      'read-only',
    );
  });

  it('publishes what the dialog starts from', () => {
    const c = core();
    expect(c.tableSize.get()).toBeNull();
    withTable(c, 2, 2);
    caretInCell(c, 1, 1);
    c.run('setTableSize', { tableSize: { columnWidths: [900, 1100], rowHeight: 800 } });
    const info = c.tableSize.get();
    expect(info).toEqual({
      columnWidths: [900, 1100],
      rowHeight: 800,
      row: 1,
      column: 1,
      editable: true,
    });
  });

  it('keeps merged cells and their spans', () => {
    const c = core();
    withTable(c, 2, 2);
    caretInCell(c, 0, 0);
    expect(c.run('mergeCells', { cells: { top: 0, left: 0, bottom: 0, right: 1 } })).toBe(true);
    expect(locateCell(internals(c).state.selection.$from)).not.toBeNull();
    expect(c.run('setTableSize', { tableSize: { columnWidths: [700, 800] } })).toBe(true);
    expect(valid(c)).toEqual([]);
  });
});

describe('FE-104 criterion 3: moving blocks by command', () => {
  it('moves a paragraph up and down and keeps the caret in it', () => {
    const c = core();
    const start = bodyTexts(c);
    expect(start.length).toBeGreaterThan(2);
    const idsBefore = ids(internals(c).state.doc).sort();
    caretInBlock(c, 1);
    expect(c.run('moveBlockUp')).toBe(true);
    expect(bodyTexts(c).slice(0, 2)).toEqual([start[1], start[0]]);
    expect(internals(c).state.selection.$from.parent.textContent).toBe(start[1]);
    expect(c.run('moveBlockDown')).toBe(true);
    expect(c.run('moveBlockDown')).toBe(true);
    expect(bodyTexts(c).slice(0, 3)).toEqual([start[0], start[2], start[1]]);
    expect(internals(c).state.selection.$from.parent.textContent).toBe(start[1]);
    expect(valid(c)).toEqual([]);
    // The identifiers are the same set: nothing was recreated.
    expect(ids(internals(c).state.doc).sort()).toEqual(idsBefore);
  });

  it('is one undo step for each move', () => {
    const c = core();
    const start = bodyTexts(c);
    caretInBlock(c, 0);
    c.run('moveBlockDown');
    expect(bodyTexts(c)).not.toEqual(start);
    c.run('undo');
    expect(bodyTexts(c)).toEqual(start);
  });

  it('refuses to move the first block up and the last block down', () => {
    const c = core();
    const n = bodyTexts(c).length;
    caretInBlock(c, 0);
    expect(c.queryCommand('moveBlockUp')).toEqual({
      enabled: false,
      active: false,
      reason: 'first-block',
    });
    expect(c.queryCommand('moveBlockDown').enabled).toBe(true);
    caretInBlock(c, n - 1);
    expect(c.queryCommand('moveBlockDown').reason).toBe('last-block');
    expect(c.run('moveBlockDown')).toBe(false);
  });

  it('moves a whole table when the caret is in a cell', () => {
    const c = core();
    withTable(c, 1, 2);
    const n = bodyTexts(c).length;
    caretInCell(c, 0, 1);
    expect(c.run('moveBlockUp')).toBe(true);
    const body = internals(c).state.doc.lastChild!;
    expect(body.child(n - 2).type.name).toBe('table');
    // The caret is still in the same cell.
    expect(internals(c).state.selection.$from.parent.textContent).toBe('r0c1');
    expect(valid(c)).toEqual([]);
  });

  it('moves every block a selection touches together', () => {
    const c = core();
    const start = bodyTexts(c);
    const i = internals(c);
    const body = bodyRange(i.state.doc);
    const sizeOf = (k: number) => i.state.doc.lastChild!.child(k).nodeSize;
    const a = body.start + sizeOf(0) + 1;
    // The end is inside the second block, past its first character.
    const b = body.start + sizeOf(0) + sizeOf(1) + 2;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a, b)));
    expect(c.run('moveBlockUp')).toBe(true);
    expect(bodyTexts(c).slice(0, 3)).toEqual([start[1], start[2], start[0]]);
  });

  it('is unavailable in a read-only document', () => {
    const c = core();
    caretInBlock(c, 1);
    c.setMode('view');
    expect(c.queryCommand('moveBlockUp').reason).toBe('read-only');
    expect(c.run('moveBlockUp')).toBe(false);
  });
});
