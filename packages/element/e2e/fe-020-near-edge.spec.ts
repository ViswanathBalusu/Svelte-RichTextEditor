/**
 * FE-020 criterion 3: an overlay opened near a viewport edge is placed by Floating UI so that it
 * stays in view. The context menu is opened with a context-menu event at each corner of a small
 * viewport, and its rectangle must lie inside the viewport and next to the point.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-020-near-edge.spec.ts --retries=0
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const menu = (page: Page) => page.locator(`${editor} .de-context-menu`);

const WIDTH = 900;
const HEIGHT = 700;

async function selectText(page: Page): Promise<void> {
  await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
}

/** Sends a context-menu event at a point of the viewport to the selected text's paragraph. */
async function contextMenuAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ sel, x, y }) => {
      const host = document.querySelector(sel) as HTMLElement;
      const paragraph = [...host.shadowRoot!.querySelectorAll('.de-editing-surface p')].at(-1)!;
      paragraph.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          composed: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      );
    },
    { sel: editor, x, y },
  );
}

const rectOfMenu = (page: Page) =>
  page.evaluate((sel) => {
    const node = (document.querySelector(sel) as HTMLElement).shadowRoot!.querySelector(
      '.de-context-menu',
    ) as HTMLElement;
    const r = node.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, editor);

const corners: ReadonlyArray<readonly [string, number, number]> = [
  ['bottom-right', WIDTH - 2, HEIGHT - 2],
  ['top-left', 1, 1],
  ['bottom-left', 1, HEIGHT - 2],
  ['top-right', WIDTH - 2, 1],
];

test.describe('FE-020 criterion 3: an overlay near a viewport edge stays in view', () => {
  for (const [name, x, y] of corners) {
    test(`the menu opened at the ${name} corner is inside the viewport`, async ({ page }) => {
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await openEmbed(page);
      await mountEditor(page, { name: 'one', sub: 'ada' });
      await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
      await selectText(page);
      await contextMenuAt(page, x, y);
      await expect(menu(page)).toBeVisible();
      const r = await rectOfMenu(page);
      expect(r.width).toBeGreaterThan(0);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(r.vw);
      expect(r.bottom).toBeLessThanOrEqual(r.vh);
      // The menu touches the point's corner: it did not drift away from the pointer.
      const nearX = Math.min(Math.abs(r.left - x), Math.abs(r.right - x)) <= 8;
      const nearY = Math.min(Math.abs(r.top - y), Math.abs(r.bottom - y)) <= 8;
      expect(nearX && nearY).toBe(true);
    });
  }
});
