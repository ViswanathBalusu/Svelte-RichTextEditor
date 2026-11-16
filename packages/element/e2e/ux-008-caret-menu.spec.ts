/**
 * UX-008 criterion 1, the keyboard path (lane w3): Shift+F10 and the Menu key open the context menu
 * at the caret, in the product's element with the real core (`EditorCore.caretRect`, forwarded by
 * packages/element/src/editor.ts). The caret's place is measured in the page from a DOM range on
 * the character beside it, not taken from the core, and the menu's box is compared with it.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts ux-008-caret-menu
 * Browsers: see the story's evidence for the ones actually run.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const menu = (page: Page) => page.locator(`${editor} .de-context-menu`);

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The box of the first or the last character of the paragraph that holds `text`. */
function characterBox(page: Page, text: string, which: 'first' | 'last'): Promise<Box> {
  return page.evaluate(
    ({ sel, text, which }) => {
      const root = (document.querySelector(sel) as HTMLElement).shadowRoot!;
      const p = [...root.querySelectorAll('.de-editing-surface p')].find((e) =>
        e.textContent.includes(text),
      )!;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const node = which === 'first' ? nodes[0]! : nodes[nodes.length - 1]!;
      const range = document.createRange();
      const at = which === 'first' ? 0 : node.data.length - 1;
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    },
    { sel: editor, text, which },
  );
}

async function menuBox(page: Page): Promise<Box> {
  await expect(menu(page)).toBeVisible();
  const b = (await menu(page).boundingBox())!;
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
}

/** The menu's corner is at the caret: below it, or above it when there was no room below. */
function expectAtCaret(box: Box, caret: { x: number; top: number; bottom: number }): void {
  const inline = Math.min(Math.abs(box.left - caret.x), Math.abs(box.right - caret.x));
  expect(inline, `inline distance of the menu from the caret at x=${caret.x}`).toBeLessThanOrEqual(
    3,
  );
  const block = Math.min(Math.abs(box.top - caret.bottom), Math.abs(box.bottom - caret.bottom));
  expect(
    block,
    `block distance of the menu from the caret's lower edge at y=${caret.bottom}`,
  ).toBeLessThanOrEqual(3);
}

test.describe('UX-008: the keyboard opens the context menu at the caret', () => {
  test('Shift+F10 at the start of a paragraph, the Menu key at the end of another', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    const paragraphs = surface(page).locator('p');
    const firstText = (await paragraphs.first().textContent())!.trim();
    expect(firstText.length).toBeGreaterThan(1);

    // The caret at the start of the last paragraph.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+F10');
    const start = await characterBox(page, 'Last paragraph.', 'first');
    const atStart = await menuBox(page);
    expectAtCaret(atStart, { x: start.left, top: start.top, bottom: start.bottom });
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();

    // The caret at the end of the first paragraph: the menu follows it.
    await paragraphs.first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('ContextMenu');
    const end = await characterBox(page, firstText, 'last');
    const atEnd = await menuBox(page);
    expectAtCaret(atEnd, { x: end.right, top: end.top, bottom: end.bottom });
    expect(
      Math.abs(atEnd.top - atStart.top) + Math.abs(atEnd.left - atStart.left),
      'the two menus opened at different places',
    ).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
  });
});
