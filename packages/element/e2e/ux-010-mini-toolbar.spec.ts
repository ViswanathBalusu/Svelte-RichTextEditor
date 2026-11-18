/**
 * UX-010 criteria 1 and 4 in the product's element with the real core (lane w3): the mini toolbar
 * sits near a selection the user may change, and is not offered where the user may not change it.
 * The place of the selection's end is measured in the page from a DOM range on the character
 * beside it, not taken from the core (`EditorCore.caretRect`), and the toolbar's box is compared
 * with it.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts ux-010-mini-toolbar
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const mini = (page: Page) => page.locator(`${editor} [data-mini-toolbar]`);

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The box of the last character of the paragraph that holds `text`. */
function lastCharacterBox(page: Page, text: string): Promise<Box> {
  return page.evaluate(
    ({ sel, text }) => {
      const root = (document.querySelector(sel) as HTMLElement).shadowRoot!;
      const p = [...root.querySelectorAll('.de-editing-surface p')].find((e) =>
        e.textContent.includes(text),
      )!;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const node = nodes[nodes.length - 1]!;
      const range = document.createRange();
      range.setStart(node, node.data.length - 1);
      range.setEnd(node, node.data.length);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    },
    { sel: editor, text },
  );
}

test.describe('UX-010: the mini toolbar in the product element', () => {
  test('appears just above the end of a selection the user may change', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    await expect(mini(page)).toHaveCount(0);

    // Select the last paragraph from its start to its end, from the keyboard.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(mini(page)).toBeVisible();
    await expect(mini(page).locator('[data-command-id="format.bold"]')).toBeVisible();

    // The toolbar's inline start is at the selection's end, and its block end is above that line.
    const end = await lastCharacterBox(page, 'Last paragraph.');
    const box = (await mini(page).boundingBox())!;
    expect(
      Math.abs(box.x - end.right),
      'inline distance from the end of the selection',
    ).toBeLessThan(3);
    const gap = end.top - (box.y + box.height);
    expect(gap, 'the toolbar is above the line, not over it').toBeGreaterThanOrEqual(0);
    expect(gap, 'and close to it').toBeLessThan(48);

    // It follows the selection: a selection that ends in another paragraph moves it.
    await surface(page).locator('p').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(mini(page)).toBeVisible();
    await expect
      .poll(async () => Math.abs((await mini(page).boundingBox())!.y - box.y))
      .toBeGreaterThan(10);
  });

  test('is not offered where the user may not change the selection', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', mode: 'view' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');
    const paragraph = surface(page).locator('p', { hasText: 'Last paragraph.' });
    const box = (await paragraph.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const selected = await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
      const sel = (root as unknown as { getSelection?: () => Selection | null }).getSelection?.();
      return sel?.toString() ?? '';
    });
    expect(selected).toContain('Last paragraph.');
    await page.waitForTimeout(300);
    await expect(mini(page)).toHaveCount(0);
  });
});
