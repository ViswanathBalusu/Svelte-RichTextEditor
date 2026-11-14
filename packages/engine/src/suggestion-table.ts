/**
 * Recording whole-row and whole-table changes as suggestions (FE-045 criteria 1 to 3 and 5; 02 §5.2;
 * 03 §5; CDM-040). A pure transaction builder over an editor state, like `suggestion-block.ts`: it
 * returns the transaction, and the caller decides when to dispatch it.
 *
 * - A row a suggester inserts carries one `ins` node mark naming the user; the row stays in the
 *   table as the suggestion (criterion 1).
 * - A row a suggester deletes stays, with one `del` node mark (criterion 2). A table inserted or
 *   deleted as a whole carries the same marks on the `table` node (criterion 3). Inserting a table
 *   is not an operation here: `insertTable` is not a table operation of `table.ts`.
 * - Column insertion and deletion are not defined as block suggestions in version 1, so the
 *   builder refuses them with `suggestion` and the core reports that reason (criterion 5).
 *
 * Decisions taken here, not in the spec (recorded in docs/adr/0132-engine-3-backlog-batch.md):
 * - a row or table that carries this user's own `ins` mark is removed outright when this user
 *   deletes it, because deleting one's own insertion leaves nothing to suggest;
 * - a row or table that already carries a `del` mark is not marked a second time: the builder
 *   refuses it with `suggestion`;
 * - an inserted row keeps the header block as it is: it is not counted as a header row.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { CommandUnavailable } from './api.ts';
import type { SuggestionAuthor } from './suggestion-edit.ts';
import { gridOf, locateCell, type TableOp, tableRefusal } from './table.ts';

/** The table operations that have a suggestion form (criteria 1 to 3); the rest are refused. */
export const SUGGESTED_TABLE_OPS: ReadonlySet<TableOp> = new Set<TableOp>([
  'insertRowAbove',
  'insertRowBelow',
  'deleteRow',
  'deleteTable',
]);

/** The result of a table suggestion: the transaction, or why the change cannot be recorded. */
export type TableSuggestion = { tr: Transaction } | { refusal: CommandUnavailable };

function markOf(schema: Schema, type: 'ins' | 'del', author: SuggestionAuthor) {
  return schema.marks[type]!.create({ id: author.nextId(), user: author.user });
}

function ownMark(node: PMNode, type: 'ins' | 'del', user: string) {
  return node.marks.find((m) => m.type.name === type && m.attrs['user'] === user) ?? null;
}

/** A new row of empty cells, one per grid column, as the table commands make it. */
function emptyRow(schema: Schema, columns: number): PMNode {
  return schema.nodes['table_row']!.create(
    null,
    Array.from({ length: columns }, () => schema.nodes['table_cell']!.createAndFill()!),
  );
}

/**
 * The suggestion for a table operation at the caret. It refuses, with the reason, every case the
 * ordinary command refuses (`tableRefusal`), every operation without a suggestion form, and a row
 * or table already marked deleted.
 */
export function suggestTableOp(
  state: EditorState,
  op: TableOp,
  author: SuggestionAuthor,
): TableSuggestion {
  const refusal = tableRefusal(state, op);
  if (refusal !== null) return { refusal };
  if (!SUGGESTED_TABLE_OPS.has(op)) return { refusal: 'suggestion' };
  const loc = locateCell(state.selection.$from);
  if (!loc) return { refusal: 'not-in-table' };
  const { schema } = state;
  const tr = state.tr;

  switch (op) {
    case 'insertRowAbove':
    case 'insertRowBelow': {
      const above = op === 'insertRowAbove';
      const at = above ? loc.rowPos : loc.rowPos + loc.table.child(loc.row).nodeSize;
      const row = emptyRow(schema, gridOf(loc.table).length).mark([markOf(schema, 'ins', author)]);
      tr.insert(at, row);
      return { tr };
    }

    case 'deleteRow': {
      const row = loc.table.child(loc.row);
      if (row.marks.some((m) => m.type.name === 'del')) return { refusal: 'suggestion' };
      if (ownMark(row, 'ins', author.user)) {
        tr.delete(loc.rowPos, loc.rowPos + row.nodeSize);
      } else {
        tr.addNodeMark(loc.rowPos, markOf(schema, 'del', author));
      }
      return { tr };
    }

    case 'deleteTable': {
      const table = loc.table;
      if (table.marks.some((m) => m.type.name === 'del')) return { refusal: 'suggestion' };
      if (ownMark(table, 'ins', author.user)) {
        tr.delete(loc.tablePos, loc.tablePos + table.nodeSize);
      } else {
        tr.addNodeMark(loc.tablePos, markOf(schema, 'del', author));
      }
      return { tr };
    }

    case 'insertColumnLeft':
    case 'insertColumnRight':
    case 'deleteColumn':
      return { refusal: 'suggestion' };
  }
}
