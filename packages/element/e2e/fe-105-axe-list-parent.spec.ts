/**
 * FE-105 criterion 3 (lane V-FE-097-112): when numbered paragraphs are exposed as list items, axe
 * reports no `aria-required-parent` or `aria-required-children` violation. The paragraphs are
 * numbered through the body view's transactions on the S1 page, as an edit would number them, and
 * axe pierces the shadow root. The list items have no `role="list"` parent yet (FE-105 Notes), so
 * the expectation below is the violation that is still there; `test.fail` keeps the suite green
 * while the gap is open and turns red when the gap is closed, so the criterion can then be ticked.
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57065 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-105-axe-list-parent.spec.ts --project=chromium --project=firefox --project=webkit --output <scratch dir>`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

const LIST = 'lList00000000002';
const RULES = ['aria-required-parent', 'aria-required-children'];

/** Numbers the two paragraphs of the page and adds a third, all in one list, through the body view. */
async function numberParagraphs(page: Page): Promise<void> {
  await page.evaluate(
    ({ ids, list }) => {
      type Node = { attrs: Record<string, unknown>; nodeSize: number };
      type View = {
        state: {
          doc: { descendants(f: (n: Node, pos: number) => boolean): void };
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
      const numbering = { numberingId: 'num1', level: 0, listId: list };
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
        { id: null, style: 'Normal', numbering },
        schema.text('Third item.'),
      );
      const tr = view.state.tr
        .setNodeAttribute(after.pos, 'numbering', numbering)
        .setNodeAttribute(last.pos, 'numbering', numbering)
        .insert(last.pos + last.node.nodeSize, third);
      view.dispatch(tr);
    },
    { ids: { after: SPIKE_IDS.after, last: SPIKE_IDS.last }, list: LIST },
  );
}

test.describe('list items have a list parent under axe (FE-105, criterion 3)', () => {
  test('axe reports no aria-required-parent or aria-required-children on numbered paragraphs', async ({
    page,
  }) => {
    // Open: the list items have no list parent (FE-105 Notes; ADR 0306). The test is expected to fail
    // until a design gives them one; when it passes, the expectation is met and the mark must go.
    test.fail(true, 'FE-105 criterion 3 is open: the listitems have no role="list" parent');
    await openS1(page);
    await numberParagraphs(page);
    const items = await page.evaluate(
      () =>
        document
          .querySelector('doc-editor')!
          .shadowRoot!.querySelectorAll('.de-editing-surface [role="listitem"]').length,
    );
    expect(items).toBe(3);
    const results = await new AxeBuilder({ page }).include('doc-editor').withRules(RULES).analyze();
    const violations = results.violations.map((v) => ({
      id: v.id,
      count: v.nodes.length,
    }));
    expect(violations).toEqual([]);
  });
});
