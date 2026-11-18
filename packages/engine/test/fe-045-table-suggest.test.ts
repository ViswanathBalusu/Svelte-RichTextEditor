/**
 * Suggesting whole-row and whole-table changes through the core (FE-045 criteria 1 to 5; 02 §5.2;
 * 03 §5). The core is headless, in review mode, for the user `alice`: the table is built in edit
 * mode and the document is reopened in review mode, so that the commands run through `run` and
 * `queryCommand` as the element runs them. The authority's commit and the view's decorations are not
 * run here (FE-045 criterion 6 stays open; see the story Notes).
 */
import { validate } from '@docedit/model/validate';
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { blockEntries } from '../src/block-suggestion.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';
import { microtask } from './support.ts';

const ROWS = 3;

/** The spike document with a 3 by 2 table in the body, built in edit mode. */
function tableDocument(): CdmEnvelope {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(c);
  const { schema } = i;
  const table = schema.nodes['table']!.create(
    { grid: [1440, 1440], headerRows: 0 },
    Array.from({ length: ROWS }, (_, r) =>
      schema.nodes['table_row']!.create(
        null,
        [0, 1].map((col) =>
          schema.nodes['table_cell']!.create(
            null,
            schema.nodes['paragraph']!.create(null, schema.text(`r${r}c${col}`)),
          ),
        ),
      ),
    ),
  );
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, table));
  return c.getContent();
}

/** The same document opened in review mode for `alice`, with the core's identifier source. */
function reviewer(doc: CdmEnvelope = tableDocument()): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc,
    schedule: microtask,
    mode: 'review',
    user: 'alice',
    access: editorAccess(),
    generateId: () => `a${String(++n).padStart(15, '0')}`,
  });
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

/** The position inside the first paragraph of the cell at (row, col), by the table's own order. */
function cellTextPos(doc: PMNode, row: number, col: number): number {
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

function caretAt(c: DocumentCore, row: number, col = 0): void {
  const i = internals(c);
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, cellTextPos(i.state.doc, row, col))),
  );
}

const marksOf = (node: PMNode): string[] => blockEntries(node).map((e) => e.type);

describe('whole-row suggestions (FE-045 criteria 1 and 2)', () => {
  it('inserting a row records it as a row with one ins entry in suggest and keeps the others', () => {
    const c = reviewer();
    caretAt(c, 1);
    expect(c.run('insertRowBelow')).toBe(true);
    const table = tableOf(internals(c).state.doc);
    expect(table.childCount).toBe(ROWS + 1);
    const inserted = table.child(2);
    expect(marksOf(inserted)).toEqual(['ins']);
    expect(blockEntries(inserted)[0]!.attrs.user).toBe('alice');
    expect(blockEntries(table.child(1))).toHaveLength(0);
    expect(blockEntries(table.child(3))).toHaveLength(0);
  });

  it('the document stays valid under the CDM validator after suggested row changes', () => {
    const c = reviewer();
    caretAt(c, 1);
    c.run('insertRowBelow');
    caretAt(c, 1);
    c.run('deleteRow');
    const env = { ...c.getContent(), doc: internals(c).state.doc.toJSON() };
    expect(validate(env).violations).toEqual([]);
  });

  it('deleting a row keeps the row and marks it del', () => {
    const c = reviewer();
    caretAt(c, 1);
    expect(c.run('deleteRow')).toBe(true);
    const table = tableOf(internals(c).state.doc);
    expect(table.childCount).toBe(ROWS);
    expect(marksOf(table.child(1))).toEqual(['del']);
    expect(table.child(1).textContent).toBe('r1c0r1c1');
  });

  it('deleting a row the same user inserted removes it, since nothing remains to suggest', () => {
    const c = reviewer();
    caretAt(c, 1);
    c.run('insertRowBelow');
    caretAt(c, 2);
    expect(c.run('deleteRow')).toBe(true);
    const table = tableOf(internals(c).state.doc);
    expect(table.childCount).toBe(ROWS);
    expect(table.children.every((row) => marksOf(row).length === 0)).toBe(true);
  });

  it('a row already marked del is refused and nothing changes', () => {
    const c = reviewer();
    caretAt(c, 1);
    c.run('deleteRow');
    const before = internals(c).state.doc;
    expect(c.run('deleteRow')).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('property: inserting and deleting rows at any row keeps every row and its marks valid', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            row: fc.integer({ min: 0, max: ROWS - 1 }),
            op: fc.constantFrom('insertRowAbove', 'insertRowBelow', 'deleteRow'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (steps) => {
          const c = reviewer();
          for (const { row, op } of steps) {
            caretAt(c, Math.min(row, tableOf(internals(c).state.doc).childCount - 1));
            c.run(op);
          }
          const table = tableOf(internals(c).state.doc);
          // Every row is still a regular row of two cells, and no row carries a foreign mark.
          expect(table.childCount).toBeGreaterThanOrEqual(1);
          table.forEach((row) => {
            expect(row.childCount).toBe(2);
            for (const e of blockEntries(row)) expect(['ins', 'del']).toContain(e.type);
          });
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('whole-table suggestions (FE-045 criterion 3)', () => {
  it('deleting a table marks the table del and keeps it in the document', () => {
    const c = reviewer();
    caretAt(c, 0);
    expect(c.run('deleteTable')).toBe(true);
    const table = tableOf(internals(c).state.doc);
    expect(marksOf(table)).toEqual(['del']);
    expect(table.childCount).toBe(ROWS);
  });
});

describe('column, merge and split suggestions are unavailable (FE-045 criterion 5)', () => {
  it('insert and delete column are unavailable with the suggestion reason and change nothing', () => {
    const c = reviewer();
    caretAt(c, 1);
    for (const op of ['insertColumnLeft', 'insertColumnRight', 'deleteColumn'] as const) {
      expect(c.queryCommand(op)).toEqual({ enabled: false, active: false, reason: 'suggestion' });
    }
    const before = internals(c).state.doc;
    expect(c.run('insertColumnRight')).toBe(false);
    expect(c.run('deleteColumn')).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('merging cells is unavailable with the suggestion reason, refused, and changes nothing', () => {
    const cells = { top: 1, left: 0, bottom: 1, right: 1 };
    // The same merge is available in edit mode, so the reason comes from suggestion mode alone.
    const editor = new DocumentCore({ doc: tableDocument(), schedule: microtask });
    caretAt(editor, 1);
    expect(editor.queryCommand('mergeCells', { cells })).toEqual({ enabled: true, active: false });

    const c = reviewer();
    caretAt(c, 1);
    expect(c.queryCommand('mergeCells', { cells })).toEqual({
      enabled: false,
      active: false,
      reason: 'suggestion',
    });
    const before = internals(c).state.doc;
    expect(c.run('mergeCells', { cells })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(c.refusal.get()?.reason).toBe('suggestion');
  });

  it('splitting a merged cell is unavailable with the suggestion reason and changes nothing', () => {
    // Row 1 is merged in edit mode, then the document is reopened in review mode.
    const editor = new DocumentCore({ doc: tableDocument(), schedule: microtask });
    caretAt(editor, 1);
    expect(editor.run('mergeCells', { cells: { top: 1, left: 0, bottom: 1, right: 1 } })).toBe(
      true,
    );
    caretAt(editor, 1);
    expect(editor.queryCommand('splitCell')).toEqual({ enabled: true, active: false });

    const c = reviewer(editor.getContent());
    caretAt(c, 1);
    expect(c.queryCommand('splitCell')).toEqual({
      enabled: false,
      active: false,
      reason: 'suggestion',
    });
    const before = internals(c).state.doc;
    expect(c.run('splitCell')).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    expect(c.refusal.get()?.reason).toBe('suggestion');
  });

  it('splitting a cell that is not merged also gives the suggestion reason', () => {
    const c = reviewer();
    caretAt(c, 1);
    expect(c.queryCommand('splitCell')).toEqual({
      enabled: false,
      active: false,
      reason: 'suggestion',
    });
  });

  it('row commands stay available with a suggestion', () => {
    const c = reviewer();
    caretAt(c, 1);
    expect(c.queryCommand('insertRowAbove')).toEqual({ enabled: true, active: false });
    expect(c.queryCommand('deleteRow')).toEqual({ enabled: true, active: false });
  });
});

describe('text in a cell is a text suggestion (FE-045 criterion 4, FE-042)', () => {
  it('typing in a cell of a suggesting user records an ins mark in that cell', () => {
    const c = reviewer();
    caretAt(c, 2, 1);
    const i = internals(c);
    i.dispatch(i.state.tr.insertText('X', i.state.selection.from));
    const cell = tableOf(internals(c).state.doc).child(2).child(1);
    const inserted = cell.firstChild!.childCount > 0 ? cell.firstChild! : null;
    expect(inserted).not.toBeNull();
    const hasIns = (node: PMNode): boolean => {
      let found = false;
      node.descendants((n) => {
        if (n.marks.some((m) => m.type.name === 'ins' && m.attrs['user'] === 'alice')) found = true;
        return !found;
      });
      return found;
    };
    expect(hasIns(cell)).toBe(true);
    // The table rows around it are not changed.
    expect(blockEntries(tableOf(internals(c).state.doc).child(0))).toHaveLength(0);
  });
});
