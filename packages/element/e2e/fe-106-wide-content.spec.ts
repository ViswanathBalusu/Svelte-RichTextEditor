/**
 * FE-106 criterion 2 (lane V-FE-097-112): tables and images wider than the viewport are the only
 * content that may scroll sideways, and they scroll (or are held) inside their own containers.
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57062 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-106-wide-content.spec.ts --project=chromium --project=firefox --project=webkit`.
 *
 * The model has no widths for table cells, and an image node renders an empty span with no size
 * (packages/engine/src/schema.ts). So the wide content is a stand-in: a style injected into the
 * element's shadow root gives the cells a minimum width of 600 CSS pixels, and gives the image span
 * an inline size of 600 CSS pixels. The shadow root is the product's own; only the sizes are stand-ins.
 */
import { type Page, expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

const WIDTH = 320;
const STAND_IN_PX = 600;

test.use({ viewport: { width: WIDTH, height: 700 } });

/** Inserts a node built by the editor's schema after the last paragraph, through the body view. */
async function insertAfterLast(page: Page, kind: 'table' | 'image'): Promise<void> {
  await page.evaluate(
    ({ id, kind }) => {
      type Node = { attrs: Record<string, unknown>; nodeSize: number };
      type Schema = {
        nodes: Record<string, { create(attrs: unknown, content?: unknown): Node }>;
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
      const target = last as { pos: number; node: Node };
      const { nodes } = view.state.schema;
      const paragraph = (content: unknown) =>
        nodes['paragraph']!.create({ id: null, style: 'Normal', numbering: null }, content);
      let block: Node;
      if (kind === 'image') {
        // 9000 twips is 600 CSS pixels at 96 dpi (15 twips per pixel).
        block = paragraph(
          nodes['image']!.create({ asset: 'fe-106-stand-in', width: 9000, height: 800 }),
        );
      } else {
        const cell = (text: string) =>
          nodes['table_cell']!.create(
            { colspan: 1, rowspan: 1 },
            paragraph(view.state.schema.text(text)),
          );
        const row = nodes['table_row']!.create(null, [
          cell('Column one'),
          cell('Column two'),
          cell('Column three'),
        ]);
        block = nodes['table']!.create(null, [row]);
      }
      view.dispatch(view.state.tr.insert(target.pos + target.node.nodeSize, block));
    },
    { id: SPIKE_IDS.last, kind },
  );
}

/** Injects a stand-in style into the element's shadow root, as a host or an author's layout would. */
async function injectStandIn(page: Page, css: string): Promise<void> {
  await page.evaluate((text) => {
    const root = document.querySelector('doc-editor')!.shadowRoot!;
    const style = document.createElement('style');
    style.setAttribute('data-fe-106-stand-in', '');
    style.textContent = text;
    root.appendChild(style);
  }, css);
}

interface Wide {
  pageScrollWidth: number;
  surfaceScrollWidth: number;
  surfaceClientWidth: number;
  /** Elements that spill past their box without a scroll container of their own. */
  spilling: string[];
  /** Rectangles that reach past the viewport's right edge. */
  pastEdge: string[];
  tables: Array<{ scrollWidth: number; clientWidth: number; overflowX: string }>;
  imageWidth: number | null;
  imageContainer: number | null;
}

function measure(page: Page): Promise<Wide> {
  return page.evaluate((width) => {
    const host = document.querySelector('doc-editor')!;
    const surface = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
    const describe = (el: Element) => `${el.tagName.toLowerCase()}.${el.className || '-'}`;
    const spilling = [...surface.querySelectorAll('*')]
      .filter((el) => {
        const style = getComputedStyle(el);
        const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
        return !scrolls && el.scrollWidth > el.clientWidth + 0.5 && el.clientWidth > 0;
      })
      .map(describe);
    // Cells inside a table's own scroll box are clipped by it, so only content outside a table is
    // compared with the viewport here; a table's box itself is compared below through `tables`.
    const pastEdge = [...surface.querySelectorAll('p, .de-image, table')]
      .filter((el) => el.tagName === 'TABLE' || !el.closest('table'))
      .filter((el) => el.getBoundingClientRect().right > width + 0.5)
      .map(describe);
    const tables = [...surface.querySelectorAll('table')].map((t) => ({
      scrollWidth: t.scrollWidth,
      clientWidth: t.clientWidth,
      overflowX: getComputedStyle(t).overflowX,
    }));
    const image = surface.querySelector('.de-image') as HTMLElement | null;
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      surfaceScrollWidth: surface.scrollWidth,
      surfaceClientWidth: surface.clientWidth,
      spilling,
      pastEdge,
      tables,
      imageWidth: image ? image.getBoundingClientRect().width : null,
      imageContainer: image ? (image.parentElement as HTMLElement).clientWidth : null,
    };
  }, WIDTH);
}

test.describe('wide tables and images in the web view at 320 CSS pixels (FE-106 criterion 2)', () => {
  test('an image wider than the viewport is held in its paragraph and does not widen the page', async ({
    page,
  }) => {
    await openS1(page);
    await insertAfterLast(page, 'image');
    await expect(page.locator('doc-editor .de-editing-surface .de-image')).toHaveCount(1);
    await injectStandIn(
      page,
      `.de-image { display: inline-block; inline-size: ${STAND_IN_PX}px; block-size: 40px; }`,
    );
    const wide = await measure(page);
    expect(wide.pageScrollWidth).toBeLessThanOrEqual(WIDTH);
    expect(wide.surfaceScrollWidth).toBeLessThanOrEqual(wide.surfaceClientWidth);
    expect(wide.pastEdge).toEqual([]);
    expect(wide.imageWidth).not.toBeNull();
    expect(wide.imageWidth!).toBeLessThanOrEqual(wide.imageContainer! + 0.5);
  });

  test('a table wider than the viewport scrolls in its own box and nothing else scrolls', async ({
    page,
  }) => {
    await openS1(page);
    await insertAfterLast(page, 'table');
    await expect(page.locator('doc-editor .de-editing-surface table')).toHaveCount(1);
    await injectStandIn(page, `td { min-inline-size: ${STAND_IN_PX}px; }`);
    const wide = await measure(page);
    const [table] = wide.tables;
    expect(table).toBeDefined();
    // The table is wider than its box, so it scrolls inside the box, as the rule says.
    expect(table!.overflowX).toBe('auto');
    expect(table!.scrollWidth).toBeGreaterThan(table!.clientWidth);
    // The page and the surface do not move sideways; only the table does.
    expect(wide.pageScrollWidth).toBeLessThanOrEqual(WIDTH);
    expect(wide.surfaceScrollWidth).toBeLessThanOrEqual(wide.surfaceClientWidth);
    expect(wide.spilling).toEqual([]);
    expect(wide.pastEdge).toEqual([]);
  });
});
