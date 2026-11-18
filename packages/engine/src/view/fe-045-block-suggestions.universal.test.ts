/**
 * Block suggestions in the mounted body view (FE-045 criterion 6, FE-046 criterion 1 for blocks; lane
 * w1). A row, a table and a paragraph that carry `ins`, `del` and `fmt` entries in their `suggest`
 * attribute (owner decision 92) are drawn by the shipped `element.css`:
 *
 * - no element is put around a marked block, so a table with suggested rows keeps its layout: the
 *   rows are the only children of the row container, every row is as wide as the table, the cells of
 *   a column start at the same left edge in every row, and the rows follow one another without a gap;
 * - each kind differs from the others without colour (a line, a bar style), and each author has a
 *   colour and a second cue (the line style), also on the cells of a suggested row and table.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`; in Node.js
 * there is no DOM, so the suite is skipped there. See docs/adr/0302-lane-V-FE-033-048.md (option 2).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope } from '../api.ts';
import { addBlockEntry, entry } from '../block-suggestion.ts';
import { bodyRange } from '../body.ts';
import { DocumentCore } from '../headless.ts';
import { spikeDocument } from '../spike-document.ts';
import { authorTone } from '../suggestion-markup.ts';
import { internals } from '../testing.ts';
import { editorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';
// The shipped style sheet of the element, as text: the cues come from the real rules.
import elementCss from '../../../element/src/styles/element.css?raw';

const isBrowser = typeof document !== 'undefined';
const ROWS = 4;
const microtask = (run: () => void) => queueMicrotask(run);

/** The spike document with a 4 by 3 table at the end of the body, built in edit mode. */
function tableDocument(): CdmEnvelope {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(c);
  const { schema } = i;
  const table = schema.nodes['table']!.create(
    { grid: [1440, 2880, 1440], headerRows: 0 },
    Array.from({ length: ROWS }, (_, r) =>
      schema.nodes['table_row']!.create(
        null,
        [0, 1, 2].map((col) =>
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

/** Two users whose author tones differ, found from the tone function itself. */
function twoUsers(): [string, string] {
  const first = 'alice';
  for (const name of ['bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi']) {
    if (authorTone(name) !== authorTone(first)) return [first, name];
  }
  throw new Error('no second tone found');
}

function positionsOf(doc: PMNode, type: string): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) out.push(pos);
    return true;
  });
  return out;
}

async function withView(
  run: (ctx: { surface: HTMLElement; core: EditorCore }) => Promise<void> | void,
): Promise<void> {
  const style = document.createElement('style');
  style.textContent = elementCss;
  document.head.append(style);
  const host = document.createElement('div');
  document.body.append(host);
  let n = 0;
  const core = new EditorCore({
    doc: tableDocument(),
    access: editorAccess(),
    schedule: microtask,
    generateId: () => `a${String(++n).padStart(15, '0')}`,
  });
  const unmount = core.mountBody(host);
  try {
    const surface = document.querySelector<HTMLElement>('.de-editing-surface');
    if (!surface) throw new Error('the body surface was not mounted');
    await run({ surface, core });
  } finally {
    unmount();
    core.destroy();
    host.remove();
    style.remove();
  }
}

describe.skipIf(!isBrowser)('suggested rows keep the table layout (FE-045 criterion 6)', () => {
  it('draws a marked row with no element around it, and keeps the rows and cells aligned', async () => {
    await withView(async ({ surface, core }) => {
      const i = internals(core);
      const rows = positionsOf(i.state.doc, 'table_row');
      expect(rows).toHaveLength(ROWS);
      const [alice, bob] = twoUsers();
      const tr0 = i.state.tr;
      addBlockEntry(tr0, rows[1]!, entry('ins', 'row-ins', alice));
      addBlockEntry(tr0, rows[2]!, entry('del', 'row-del', bob));
      i.dispatch(tr0);
      await vi.waitFor(() => expect(surface.querySelector('tr.de-suggest-ins')).not.toBeNull());

      // No element around a marked row: the row container holds the rows and nothing else, and no
      // element carries the attribute that a suggestion mark's element had (FE-045 criterion 1).
      const marked = surface.querySelector<HTMLElement>('tr.de-suggest-ins')!;
      expect([...marked.parentElement!.children].every((el) => el.tagName === 'TR')).toBe(true);
      expect(surface.querySelector('[data-suggestion]')).toBeNull();
      expect(surface.querySelector('.de-suggest-wrap')).toBeNull();

      const table = surface.querySelector<HTMLElement>('table')!;
      const trs = [...table.querySelectorAll<HTMLElement>('tr')];
      expect(trs).toHaveLength(ROWS);
      const tableBox = table.getBoundingClientRect();
      const cellsOf = (tr: HTMLElement) => [...tr.querySelectorAll<HTMLElement>('td, th')];
      const firstRowCells = cellsOf(trs[0]!).map((c) => c.getBoundingClientRect());
      expect(firstRowCells).toHaveLength(3);
      const firstRowBox = trs[0]!.getBoundingClientRect();
      // The vertical space between rows is the table's own border spacing.
      const spacing = Number.parseFloat(getComputedStyle(table).borderSpacing.split(' ').pop()!);
      let previousBottom = Number.NaN;
      for (const [index, tr] of trs.entries()) {
        const box = tr.getBoundingClientRect();
        // Every row is as wide as the first, unmarked row and starts where it does, and the rows
        // follow one another by the table's own spacing, with no gap or overlap of a wrapper's.
        expect(box.width, `row ${index} width`).toBeCloseTo(firstRowBox.width, 0);
        expect(box.left, `row ${index} left`).toBeCloseTo(firstRowBox.left, 0);
        expect(box.left, `row ${index} inside the table`).toBeGreaterThanOrEqual(tableBox.left);
        expect(box.right, `row ${index} inside the table`).toBeLessThanOrEqual(
          tableBox.right + 0.5,
        );
        expect(box.height, `row ${index} height`).toBeGreaterThan(0);
        if (index > 0) expect(box.top - previousBottom, `row ${index} gap`).toBeCloseTo(spacing, 0);
        previousBottom = box.bottom;
        // The cells of each column start where those of the first row do, and are as wide.
        const cells = cellsOf(tr).map((c) => c.getBoundingClientRect());
        expect(cells, `row ${index} cells`).toHaveLength(3);
        for (const [col, cell] of cells.entries()) {
          expect(cell.left, `row ${index} col ${col} left`).toBeCloseTo(
            firstRowCells[col]!.left,
            0,
          );
          expect(cell.width, `row ${index} col ${col} width`).toBeCloseTo(
            firstRowCells[col]!.width,
            0,
          );
        }
      }
    });
  });

  it('keeps the layout of a table that is a suggested insertion', async () => {
    await withView(async ({ surface, core }) => {
      const i = internals(core);
      const [alice] = twoUsers();
      const before = surface.querySelector<HTMLElement>('table')!.getBoundingClientRect();
      const [tablePos] = positionsOf(i.state.doc, 'table');
      i.dispatch(addBlockEntry(i.state.tr, tablePos!, entry('ins', 'table-ins', alice)));
      await vi.waitFor(() => expect(surface.querySelector('table.de-suggest-ins')).not.toBeNull());
      const table = surface.querySelector<HTMLElement>('table.de-suggest-ins')!;
      // The table sits where it did, with the size it had (the bar is on paragraphs, not on a table).
      const after = table.getBoundingClientRect();
      expect(after.left).toBeCloseTo(before.left, 0);
      expect(after.width).toBeCloseTo(before.width, 0);
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(table.querySelectorAll('tr')).toHaveLength(ROWS);
    });
  });
});

describe.skipIf(!isBrowser)(
  'block suggestions are told apart without colour (FE-046 criterion 1)',
  () => {
    it('gives each kind its own line and bar style, and each author a colour and a line style', async () => {
      await withView(async ({ surface, core }) => {
        const i = internals(core);
        const [alice, bob] = twoUsers();
        const paragraphs = positionsOf(i.state.doc, 'paragraph').filter(
          (pos) => i.state.doc.resolve(pos).parent.type.name === 'body',
        );
        expect(paragraphs.length).toBeGreaterThanOrEqual(3);
        const rows = positionsOf(i.state.doc, 'table_row');
        const tr = i.state.tr;
        addBlockEntry(tr, paragraphs[0]!, entry('ins', 'p-ins', alice));
        addBlockEntry(tr, paragraphs[1]!, entry('del', 'p-del', bob));
        addBlockEntry(tr, paragraphs[2]!, entry('fmt', 'p-fmt', alice));
        addBlockEntry(tr, rows[0]!, entry('ins', 'r-ins', alice));
        addBlockEntry(tr, rows[1]!, entry('del', 'r-del', bob));
        i.dispatch(tr);
        await vi.waitFor(() =>
          expect(surface.querySelector('[data-suggestion-id="r-del"]')).not.toBeNull(),
        );
        const find = (id: string) =>
          surface.querySelector<HTMLElement>(`[data-suggestion-id="${id}"]`)!;
        const style = (el: Element) => getComputedStyle(el);

        // A paragraph: the line is the kind, the bar style is the kind.
        expect(style(find('p-ins')).textDecorationLine).toContain('underline');
        expect(style(find('p-del')).textDecorationLine).toContain('line-through');
        expect(style(find('p-fmt')).textDecorationLine).toContain('overline');
        expect(style(find('p-ins')).borderInlineStartStyle).toBe('solid');
        expect(style(find('p-del')).borderInlineStartStyle).toBe('dashed');
        expect(style(find('p-fmt')).borderInlineStartStyle).toBe('dotted');
        expect(style(find('p-ins')).borderInlineStartWidth).toBe('3px');

        // The author: a colour and a second cue, the line style, that differ between two authors.
        const mine = style(find('p-ins'));
        const theirs = style(find('p-del'));
        expect(mine.getPropertyValue('--de-tone')).not.toBe(theirs.getPropertyValue('--de-tone'));
        expect(mine.borderInlineStartColor).not.toBe(theirs.borderInlineStartColor);
        expect(mine.getPropertyValue('--de-tone-style')).not.toBe(
          theirs.getPropertyValue('--de-tone-style'),
        );
        expect(mine.textDecorationStyle).toBe(mine.getPropertyValue('--de-tone-style').trim());

        // A row has no text of its own: its cells take the line, the colour and the line style.
        const insCell = find('r-ins').querySelector('td')!;
        const delCell = find('r-del').querySelector('td')!;
        expect(style(insCell).textDecorationLine).toContain('underline');
        expect(style(delCell).textDecorationLine).toContain('line-through');
        expect(style(insCell).textDecorationStyle).toBe(mine.textDecorationStyle);
        expect(style(delCell).textDecorationStyle).toBe(theirs.textDecorationStyle);
        expect(style(insCell).textDecorationColor).toBe(mine.textDecorationColor);
        expect(style(delCell).textDecorationColor).toBe(theirs.textDecorationColor);
        expect(style(insCell).textDecorationColor).not.toBe(style(delCell).textDecorationColor);
      });
    });
  },
);
