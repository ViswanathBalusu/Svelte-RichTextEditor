/**
 * List semantics on the editing surface (FE-105 criteria 1 and 2): numbered paragraphs of the body
 * carry `role="listitem"`, `aria-level`, `aria-posinset` and `aria-setsize` in the shadow root's
 * DOM, from the web view's list plugin (packages/engine/src/view/list-view.ts). The paragraphs are
 * numbered through the body view's own transactions on the S1 page, as an edit would number them.
 */
import { type Page, expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

const LIST = 'lList00000000001';

interface Item {
  text: string;
  role: string | null;
  level: string | null;
  posinset: string | null;
  setsize: string | null;
}

/**
 * Numbers `after` and `last` at the given levels and adds a third numbered paragraph after them,
 * all in one list, through the body view's dispatch.
 */
async function numberParagraphs(page: Page, levels: [number, number, number]): Promise<void> {
  await page.evaluate(
    ({ ids, levels, list }) => {
      type Node = {
        attrs: Record<string, unknown>;
        nodeSize: number;
      };
      type View = {
        state: {
          doc: {
            descendants(f: (n: Node, pos: number) => boolean): void;
          };
          schema: {
            nodes: Record<string, { create(attrs: unknown, content: unknown): unknown }>;
            text(t: string): unknown;
          };
          tr: {
            setNodeAttribute(pos: number, name: string, value: unknown): View['state']['tr'];
            insert(pos: number, node: unknown): View['state']['tr'];
          };
        };
        dispatch(tr: unknown): void;
      };
      const view = (window as unknown as { h: { view: View } }).h.view;
      const numbering = (level: number) => ({ numberingId: 'num1', level, listId: list });
      const find = (id: string): { pos: number; node: Node } => {
        let found: { pos: number; node: Node } | null = null;
        view.state.doc.descendants((node, pos) => {
          if (!found && node.attrs['id'] === id) found = { pos, node };
          return !found;
        });
        if (!found) throw new Error(`no node ${id}`);
        return found;
      };
      const after = find(ids.after);
      const last = find(ids.last);
      const { schema } = view.state;
      const third = schema.nodes['paragraph']!.create(
        { id: null, style: 'Normal', numbering: numbering(levels[2]) },
        schema.text('Third item.'),
      );
      const tr = view.state.tr
        .setNodeAttribute(after.pos, 'numbering', numbering(levels[0]))
        .setNodeAttribute(last.pos, 'numbering', numbering(levels[1]))
        .insert(last.pos + last.node.nodeSize, third);
      view.dispatch(tr);
    },
    { ids: { after: SPIKE_IDS.after, last: SPIKE_IDS.last }, levels, list: LIST },
  );
}

/** The list items of the editing surface as the accessibility attributes describe them. */
function listItems(page: Page): Promise<Item[]> {
  return page.evaluate(() => {
    const root = document.querySelector('doc-editor')!.shadowRoot!;
    const surface = root.querySelector('.de-editing-surface')!;
    return [...surface.querySelectorAll('[role="listitem"]')].map((el) => ({
      text: el.textContent ?? '',
      role: el.getAttribute('role'),
      level: el.getAttribute('aria-level'),
      posinset: el.getAttribute('aria-posinset'),
      setsize: el.getAttribute('aria-setsize'),
    }));
  });
}

test('three consecutive numbered paragraphs expose their position and the list size', async ({
  page,
}) => {
  await openS1(page);
  expect(await listItems(page)).toEqual([]);
  await numberParagraphs(page, [0, 0, 0]);
  expect(await listItems(page)).toEqual([
    { text: 'Remote target paragraph.', role: 'listitem', level: '1', posinset: '1', setsize: '3' },
    { text: 'Last paragraph.', role: 'listitem', level: '1', posinset: '2', setsize: '3' },
    { text: 'Third item.', role: 'listitem', level: '1', posinset: '3', setsize: '3' },
  ]);
});

test('a paragraph at a nested numbering level exposes its level', async ({ page }) => {
  await openS1(page);
  await numberParagraphs(page, [0, 1, 0]);
  expect(await listItems(page)).toEqual([
    { text: 'Remote target paragraph.', role: 'listitem', level: '1', posinset: '1', setsize: '2' },
    { text: 'Last paragraph.', role: 'listitem', level: '2', posinset: '1', setsize: '1' },
    { text: 'Third item.', role: 'listitem', level: '1', posinset: '2', setsize: '2' },
  ]);
});
