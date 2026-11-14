/**
 * A suggested table row in the mounted body view (FE-045 criterion 1, lane U-FE-033-048): a row that
 * a reviewer inserts carries one `ins` node mark, is drawn with the class `de-suggest-ins` as a node
 * decoration on its own `tr`, and adds no wrapper element: every child of the table's row container
 * is still a row. The same view draws a suggested text run as `de-suggest-ins` (FE-046 criterion 4).
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`; in Node.js
 * there is no DOM, so the suite is skipped there. The row rules themselves are tested in
 * test/fe-045-table-suggest.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope } from '../api.ts';
import { bodyRange } from '../body.ts';
import { DocumentCore } from '../headless.ts';
import { spikeDocument } from '../spike-document.ts';
import { internals } from '../testing.ts';
import { editorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

const isBrowser = typeof document !== 'undefined';
const ROWS = 3;
const microtask = (run: () => void) => queueMicrotask(run);

/** The spike document with a 3 by 2 table at the end of the body, built in edit mode. */
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

/** The position inside the first paragraph of the cell at (row, col). */
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

describe.skipIf(!isBrowser)('suggested rows in the body view (FE-045 criterion 1)', () => {
  // Known defect, found by this test (lane U-FE-033-048): the `ins` mark on the inserted row is
  // rendered by the view as an `<ins>` element that wraps the `tr` inside `tbody`, so the row has a
  // wrapper and the table is not valid markup. The test is `it.fails` until the rendering is fixed;
  // when it passes, change `it.fails` back to `it` and tick the criterion.
  it.fails(
    'a row inserted in review mode is drawn as a decoration on its own row, with no wrapper',
    async () => {
      const host = document.createElement('div');
      document.body.append(host);
      let n = 0;
      const core = new EditorCore({
        doc: tableDocument(),
        mode: 'review',
        user: 'alice',
        access: editorAccess(),
        schedule: microtask,
        generateId: () => `a${String(++n).padStart(15, '0')}`,
      });
      const unmount = core.mountBody(host);
      try {
        const surface = document.querySelector<HTMLElement>('.de-editing-surface');
        if (!surface) throw new Error('the body surface was not mounted');
        const i = internals(core);
        i.dispatch(
          i.state.tr.setSelection(
            TextSelection.create(i.state.doc, cellTextPos(i.state.doc, 1, 0)),
          ),
        );
        expect(core.run('insertRowBelow')).toBe(true);

        await vi.waitFor(() =>
          expect(surface.querySelectorAll('tr.de-suggest-ins')).toHaveLength(1),
        );
        const row = surface.querySelector<HTMLElement>('tr.de-suggest-ins')!;
        const container = row.parentElement!;
        // No wrapper: every child of the row container is a table row, and the table has every row.
        const rows = [...container.children];
        expect(rows.every((el) => el.tagName === 'TR')).toBe(true);
        expect(rows).toHaveLength(ROWS + 1);
        expect(row.querySelectorAll('td, th')).toHaveLength(2);
        // The row is one of the table's rows, not a copy inside a cell or a new table.
        expect(surface.querySelectorAll('table')).toHaveLength(1);
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    },
  );
});
