/**
 * Table styles and row sorting (FE-131): a table style is stored on the table and must be a table
 * style the document defines; rows sort by a column with the header rows kept at the top; empty cells
 * sort last; merged cells refuse the sort with a reason; one undo reverts a sort (criterion 5). The
 * document is the spike document with one table appended to the body, as in table.test.ts.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import {
  setTableStyle,
  sortedOrder,
  sortRefusal,
  sortTableRows,
  tableStyleRefusal,
} from '../src/table-style-sort.ts';

const microtask = (run: () => void) => queueMicrotask(run);
const collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });

/** The spike document with a table style `GridTable` added to its definitions. */
function documentWithTableStyle(): unknown {
  const doc = JSON.parse(JSON.stringify(spikeDocument())) as unknown;
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false;
    const record = node as { type?: unknown; content?: unknown[] };
    if (record.type === 'defs' && Array.isArray(record.content)) {
      // After the paragraph style `Normal`, which the spike document lists first among the styles.
      const normal = record.content.find((n) => (n as { type?: unknown }).type === 'style_def') as {
        attrs: Record<string, unknown>;
      };
      const { fontSize: _size, ...base } = normal.attrs;
      const at = record.content.indexOf(normal) + 1;
      record.content.splice(at, 0, {
        type: 'style_def',
        attrs: { ...base, id: 'GridTable', kind: 'table', name: 'Grid Table', builtIn: false },
      });
      return true;
    }
    return Object.values(node as Record<string, unknown>).some((child) =>
      Array.isArray(child) ? child.some(visit) : visit(child),
    );
  };
  if (!visit(doc)) throw new Error('no defs');
  return doc;
}

function core(): DocumentCore {
  return new DocumentCore({ doc: documentWithTableStyle() as never, schedule: microtask });
}

/**
 * Appends a table to the body. Each row is a list of cell texts; an empty text is an empty cell.
 * A cell may span columns through `colspan`, given as `{ text, colspan }`.
 */
type CellSpec = string | { text: string; colspan: number };

function withTable(c: DocumentCore, rows: CellSpec[][], headerRows = 0): void {
  const i = internals(c);
  const { schema } = i;
  const cols = rows[0]!.length;
  const table = schema.nodes['table']!.create(
    { grid: Array.from({ length: cols }, () => 1440), headerRows },
    rows.map((row) =>
      schema.nodes['table_row']!.create(
        null,
        row.map((spec) => {
          const { text, colspan } = typeof spec === 'string' ? { text: spec, colspan: 1 } : spec;
          const para =
            text === ''
              ? schema.nodes['paragraph']!.create()
              : schema.nodes['paragraph']!.create(null, schema.text(text));
          return schema.nodes['table_cell']!.create({ colspan }, para);
        }),
      ),
    ),
  );
  i.dispatch(closeHistory(i.state.tr.insert(bodyRange(i.state.doc).end, table)));
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

/** The text of each row's cell in column `col`, in order. */
function column(table: PMNode, col: number): string[] {
  const out: string[] = [];
  table.forEach((row) => out.push(row.child(col).textContent));
  return out;
}

/** The identifiers of the rows, in order. */
function rowIds(table: PMNode): unknown[] {
  const out: unknown[] = [];
  table.forEach((row) => out.push(row.attrs['id']));
  return out;
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

/** Puts the caret in a cell of the appended table. */
function caretIn(c: DocumentCore, row: number, col: number): void {
  const i = internals(c);
  const pos = textPosOf(i.state.doc, row, col);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

/** Runs a command as its own undo step, so that one undo reverts it alone. */
function run(c: DocumentCore, command: ReturnType<typeof sortTableRows>): boolean {
  const i = internals(c);
  return command(i.state, (tr) => i.dispatch(closeHistory(tr)));
}

describe('table styles (FE-131 criterion 1)', () => {
  it('stores the table style on the table at the caret and clears it with null', () => {
    const c = core();
    withTable(c, [['a', 'b']]);
    caretIn(c, 0, 0);
    const i = internals(c);
    expect(setTableStyle('GridTable')(i.state, (tr) => i.dispatch(tr))).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['style']).toBe('GridTable');
    expect(setTableStyle(null)(internals(c).state, (tr) => i.dispatch(tr))).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['style']).toBeNull();
  });

  it('refuses a style the document does not define as a table style, and changes nothing', () => {
    const c = core();
    withTable(c, [['a']]);
    caretIn(c, 0, 0);
    const state = internals(c).state;
    expect(tableStyleRefusal(state, 'Normal')).toBe('unknown-style');
    expect(tableStyleRefusal(state, 'NoSuchStyle')).toBe('unknown-style');
    expect(setTableStyle('Normal')(state)).toBe(false);
    expect(tableOf(state.doc).attrs['style']).toBeNull();
  });

  it('is unavailable outside a table', () => {
    const c = core();
    withTable(c, [['a']]);
    const state = internals(c).state;
    // The first paragraph of the body comes before the table.
    const pos = bodyRange(state.doc).start + 1;
    const outside = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    expect(tableStyleRefusal(outside, 'GridTable')).toBe('not-in-table');
    expect(setTableStyle('GridTable')(outside)).toBe(false);
  });
});

describe('sorting rows (FE-131 criteria 2 and 3)', () => {
  it('sorts the body rows ascending by the caret column, with numbers in numeric order', () => {
    const c = core();
    withTable(c, [
      ['x', 'pear'],
      ['y', '10'],
      ['z', 'apple'],
      ['w', '9'],
    ]);
    caretIn(c, 0, 1);
    expect(run(c, sortTableRows('ascending'))).toBe(true);
    expect(column(tableOf(internals(c).state.doc), 1)).toEqual(['9', '10', 'apple', 'pear']);
  });

  it('sorts descending', () => {
    const c = core();
    withTable(c, [
      ['x', 'b'],
      ['y', 'c'],
      ['z', 'a'],
    ]);
    caretIn(c, 0, 1);
    run(c, sortTableRows('descending'));
    expect(column(tableOf(internals(c).state.doc), 1)).toEqual(['c', 'b', 'a']);
  });

  it('keeps the header rows at the top', () => {
    const c = core();
    withTable(
      c,
      [
        ['Name', 'Score'],
        ['c', '3'],
        ['a', '1'],
        ['b', '2'],
      ],
      1,
    );
    caretIn(c, 1, 1);
    run(c, sortTableRows('ascending'));
    expect(column(tableOf(internals(c).state.doc), 1)).toEqual(['Score', '1', '2', '3']);
  });

  it('puts empty cells after the others in both directions', () => {
    const c = core();
    withTable(c, [
      ['', 'k'],
      ['', 'b'],
      ['', 'a'],
    ]);
    caretIn(c, 0, 0);
    run(c, sortTableRows('ascending'));
    expect(column(tableOf(internals(c).state.doc), 0)).toEqual(['', '', '']);
  });

  it('keeps the same row nodes and identifiers, only their order changes', () => {
    const c = core();
    withTable(c, [['c'], ['a'], ['b']]);
    const before = rowIds(tableOf(internals(c).state.doc));
    caretIn(c, 0, 0);
    run(c, sortTableRows('ascending'));
    const after = tableOf(internals(c).state.doc);
    expect(column(after, 0)).toEqual(['a', 'b', 'c']);
    expect([...rowIds(after)].sort()).toEqual([...before].sort());
  });

  it('refuses a table with merged cells, with the reason, and changes nothing', () => {
    const c = core();
    withTable(c, [[{ text: 'wide', colspan: 2 }], ['b', 'c']]);
    caretIn(c, 1, 0);
    const state = internals(c).state;
    expect(sortRefusal(state)).toBe('merged-cells');
    const before = tableOf(state.doc).toString();
    expect(sortTableRows('ascending')(state)).toBe(false);
    expect(tableOf(internals(c).state.doc).toString()).toBe(before);
  });

  it('refuses a column that the table does not have', () => {
    const c = core();
    withTable(c, [['a', 'b']]);
    caretIn(c, 0, 0);
    expect(sortRefusal(internals(c).state, 5)).toBe('no-column');
    expect(sortRefusal(internals(c).state, -1)).toBe('no-column');
  });

  it('is one undo step: undo returns the original order', () => {
    const c = core();
    withTable(c, [['c'], ['a'], ['b']]);
    const original = column(tableOf(internals(c).state.doc), 0);
    caretIn(c, 0, 0);
    run(c, sortTableRows('ascending'));
    expect(column(tableOf(internals(c).state.doc), 0)).toEqual(['a', 'b', 'c']);
    c.exec('undo');
    expect(column(tableOf(internals(c).state.doc), 0)).toEqual(original);
  });
});

describe('through the document API (FE-131)', () => {
  it('stores a table style through exec and reports the reason through queryCommand', () => {
    const c = core();
    withTable(c, [['a']]);
    expect(c.queryCommand('setTableStyle', { tableStyle: 'GridTable' })).toEqual({
      enabled: false,
      active: false,
      reason: 'not-in-table',
    });
    caretIn(c, 0, 0);
    expect(c.queryCommand('setTableStyle', { tableStyle: 'GridTable' }).enabled).toBe(true);
    expect(c.queryCommand('setTableStyle', { tableStyle: 'Normal' }).reason).toBe('unknown-style');
    expect(c.exec('setTableStyle', { tableStyle: 'GridTable' })).toBe(true);
    expect(tableOf(internals(c).state.doc).attrs['style']).toBe('GridTable');
    expect(c.exec('setTableStyle')).toBe(false);
  });

  it('sorts through exec, and reports merged cells through queryCommand', () => {
    const c = core();
    withTable(c, [['b'], ['a']]);
    caretIn(c, 0, 0);
    expect(c.exec('sortTableRows', { sortDirection: 'ascending' })).toBe(true);
    expect(column(tableOf(internals(c).state.doc), 0)).toEqual(['a', 'b']);
    expect(c.exec('sortTableRows')).toBe(false);

    const merged = core();
    withTable(merged, [[{ text: 'wide', colspan: 2 }], ['x', 'y']]);
    caretIn(merged, 1, 0);
    expect(merged.queryCommand('sortTableRows', { sortDirection: 'descending' })).toEqual({
      enabled: false,
      active: false,
      reason: 'merged-cells',
    });
  });
});

describe('sortedOrder (property)', () => {
  it('is a permutation, puts empty keys last, and orders the others by the collator', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant(''), fc.string({ maxLength: 4 })), { maxLength: 12 }),
        fc.constantFrom('ascending' as const, 'descending' as const),
        (keys, direction) => {
          const order = sortedOrder(keys, direction);
          expect([...order].sort((a, b) => a - b)).toEqual(keys.map((_, i) => i));
          const sorted = order.map((i) => keys[i]!);
          const firstEmpty = sorted.indexOf('');
          if (firstEmpty >= 0) expect(sorted.slice(firstEmpty).every((k) => k === '')).toBe(true);
          const filled = sorted.filter((k) => k !== '');
          for (let i = 1; i < filled.length; i++) {
            const c = collator.compare(filled[i - 1]!, filled[i]!);
            if (direction === 'ascending') expect(c).toBeLessThanOrEqual(0);
            else expect(c).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });
});
