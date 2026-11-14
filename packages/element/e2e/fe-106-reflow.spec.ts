/**
 * Reflow of the web view at 320 CSS pixels (FE-106 criteria 1, 2 and 4; WCAG 2.2 criterion 1.4.10),
 * in a real browser on the S1 page (lane U-FE-097-112). Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-106-reflow.spec.ts`.
 *
 * Criterion 1: paragraphs, including one unbroken word of 120 characters typed by the keyboard,
 * stay inside a 320 pixel wide viewport and the page does not scroll sideways.
 * Criterion 2 (partly): a table of six cells of long words, inserted through the body view as an
 * edit would, does not widen the page. The table fits its own box here, so no table wider than
 * the viewport is shown; that case is not reproduced.
 * Criterion 4 (approximated): the host's font size is doubled, which is what a larger default font
 * does to the em-based sizes; no text is clipped and the page does not scroll sideways. This is
 * not a browser text-only zoom, which Playwright cannot drive.
 * Criterion 3 is not checked: the page view (`view="print"`) is not built (FE-101).
 */
import { type Page, expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

const WIDTH = 320;
const LONG_WORD = 'W'.repeat(120);

test.use({ viewport: { width: WIDTH, height: 700 } });

interface Layout {
  viewport: number;
  pageScrollWidth: number;
  surfaceScrollWidth: number;
  surfaceClientWidth: number;
  overflowingParagraphs: string[];
  tables: Array<{ scrollWidth: number; clientWidth: number; overflowX: string }>;
}

/** Measures the editing surface of the element in the page, as the reader sees it. */
function measure(page: Page): Promise<Layout> {
  return page.evaluate((width) => {
    const host = document.querySelector('doc-editor')!;
    const surface = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
    const overflowingParagraphs = [...surface.querySelectorAll('p')]
      .filter((p) => p.getBoundingClientRect().right > width + 0.5)
      .map((p) => (p.textContent ?? '').slice(0, 20));
    const tables = [...surface.querySelectorAll('table')].map((t) => ({
      scrollWidth: t.scrollWidth,
      clientWidth: t.clientWidth,
      overflowX: getComputedStyle(t).overflowX,
    }));
    return {
      viewport: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      surfaceScrollWidth: surface.scrollWidth,
      surfaceClientWidth: surface.clientWidth,
      overflowingParagraphs,
      tables,
    };
  }, WIDTH);
}

/** Inserts a table of six cells with long words after the last paragraph, through the body view. */
async function insertWideTable(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, word }) => {
      type Node = { attrs: Record<string, unknown>; nodeSize: number };
      type Schema = {
        nodes: Record<string, { create(attrs: unknown, content: unknown): Node }>;
        text(t: string): unknown;
      };
      type View = {
        state: {
          doc: { descendants(f: (n: Node, pos: number) => boolean): void };
          schema: Schema;
          tr: { insert(pos: number, node: unknown): View['state']['tr'] };
        };
        dispatch(tr: unknown): void;
      };
      const view = (window as unknown as { h: { view: View } }).h.view;
      let last: { pos: number; node: Node } | null = null;
      view.state.doc.descendants((node, pos) => {
        if (node.attrs['id'] === id) last = { pos, node };
        return last === null;
      });
      if (!last) throw new Error(`no node ${id}`);
      const { nodes } = view.state.schema;
      const cell = (text: string) =>
        nodes['table_cell']!.create(
          { colspan: 1, rowspan: 1 },
          nodes['paragraph']!.create(
            { id: null, style: 'Normal', numbering: null },
            view.state.schema.text(text),
          ),
        );
      const row = nodes['table_row']!.create(
        null,
        [1, 2, 3, 4, 5, 6].map((n) => cell(`${word}${n}`)),
      );
      const table = nodes['table']!.create(null, [row]);
      const target = last as { pos: number; node: Node };
      view.dispatch(view.state.tr.insert(target.pos + target.node.nodeSize, table));
    },
    { id: SPIKE_IDS.last, word: 'Column' },
  );
}

test.describe('reflow of the web view at 320 CSS pixels (FE-106)', () => {
  test('paragraphs, including an unbroken word, reflow with no sideways scroll', async ({
    page,
  }) => {
    await openS1(page);
    const body = page.locator('doc-editor .de-editing-surface p', { hasText: 'Last paragraph.' });
    await body.click();
    // The keys go to the editing surface only once it holds the focus (the first typing failed in
    // Firefox when the click came before the surface took it).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector('doc-editor')!.shadowRoot!;
          const surface = root.querySelector('.de-editing-surface')!;
          return surface.contains(root.activeElement);
        }),
      )
      .toBe(true);
    await page.keyboard.press('End');
    await page.keyboard.type(` ${LONG_WORD}`);
    await expect(body).toContainText(LONG_WORD.slice(0, 20));
    const layout = await measure(page);
    expect(layout.viewport).toBe(WIDTH);
    expect(layout.pageScrollWidth).toBeLessThanOrEqual(WIDTH);
    expect(layout.surfaceScrollWidth).toBeLessThanOrEqual(layout.surfaceClientWidth);
    expect(layout.overflowingParagraphs).toEqual([]);
  });

  test('a table of six long-worded cells does not widen the page', async ({ page }) => {
    // Recorded limit: the cells wrap inside the table's box (overflow-wrap: anywhere), so this
    // table fits and does not scroll; a table whose cells cannot wrap was not produced here.
    await openS1(page);
    await insertWideTable(page);
    await expect(page.locator('doc-editor .de-editing-surface table')).toHaveCount(1);
    const layout = await measure(page);
    expect(layout.pageScrollWidth).toBeLessThanOrEqual(WIDTH);
    expect(layout.surfaceScrollWidth).toBeLessThanOrEqual(layout.surfaceClientWidth);
    expect(layout.overflowingParagraphs).toEqual([]);
    const [table] = layout.tables;
    expect(table).toBeDefined();
    expect(table!.overflowX).toBe('auto');
    expect(table!.scrollWidth).toBeLessThanOrEqual(table!.clientWidth);
  });

  test('a doubled font size clips no text and adds no sideways scroll', async ({ page }) => {
    await openS1(page);
    await page.evaluate(() => {
      (document.querySelector('doc-editor') as HTMLElement).style.fontSize = '32px';
    });
    const layout = await measure(page);
    expect(layout.pageScrollWidth).toBeLessThanOrEqual(WIDTH);
    expect(layout.surfaceScrollWidth).toBeLessThanOrEqual(layout.surfaceClientWidth);
    expect(layout.overflowingParagraphs).toEqual([]);
  });
});
