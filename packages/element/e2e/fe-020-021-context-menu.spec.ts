/**
 * FE-021 criterion 2 and FE-020 criteria 1 and 4 (lane U-FE-017-032). The context menu is the
 * overlay the editor opens inside its shadow root (UX-008, Popover API with `popover="manual"`).
 *
 * - FE-021: with focus on an item inside that overlay, Mod-B runs the bold command once.
 * - FE-020 (menu only): the menu lives in the shadow root and nothing is appended to the host
 *   page; Escape closes it and puts focus back in the editing surface.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts fe-020-021-context-menu
 * Browsers: see the story's evidence for the ones actually run.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const menu = (page: Page) => page.locator(`${editor} .de-context-menu`);

/** Selects the last paragraph's text, then opens the context menu from the keyboard at the caret. */
async function openMenuOnSelection(page: Page): Promise<void> {
  await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ''))
    .toBe('DOC-EDITOR');
}

const boldActive = (page: Page) =>
  page.evaluate(
    (sel) =>
      (
        document.querySelector(sel) as HTMLElement & {
          queryCommand(name: string): { enabled: boolean; active: boolean };
        }
      ).queryCommand('bold').active,
    editor,
  );

test.describe('FE-021 shortcuts from an overlay inside the root; FE-020 the menu stays in the root', () => {
  test('FE-021: Mod-B with focus in the context menu runs bold once', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    await expect.poll(() => boldActive(page)).toBe(false);

    await openMenuOnSelection(page);
    // Focus is on a menu item inside the overlay, not on the editing surface.
    const focusedInMenu = await page.evaluate(
      (sel) =>
        !!(document.querySelector(sel) as HTMLElement).shadowRoot?.activeElement?.closest(
          '.de-context-menu',
        ),
      editor,
    );
    expect(focusedInMenu).toBe(true);

    await page.keyboard.press('Control+B');
    await expect.poll(() => boldActive(page)).toBe(true);
    // A second run would toggle bold back off; wait a frame and check that it stayed on.
    await page.waitForTimeout(150);
    expect(await boldActive(page)).toBe(true);
  });

  test('FE-020: the menu is in the shadow root, nothing is appended to the host page, Escape restores focus', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');

    const before = await page.evaluate(() => ({
      body: document.body.childElementCount,
      head: document.head.childElementCount,
    }));
    await openMenuOnSelection(page);

    const placed = await page.evaluate((sel) => {
      const host = document.querySelector(sel) as HTMLElement;
      const inShadow = host.shadowRoot?.querySelector('.de-context-menu');
      return {
        inShadow: inShadow !== null && inShadow !== undefined,
        inLightDom: document.querySelectorAll('.de-context-menu').length,
        open: inShadow ? inShadow.matches(':popover-open') : false,
      };
    }, editor);
    expect(placed).toEqual({ inShadow: true, inLightDom: 0, open: true });

    const after = await page.evaluate(() => ({
      body: document.body.childElementCount,
      head: document.head.childElementCount,
    }));
    expect(after).toEqual(before);

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          (sel) =>
            (
              document.querySelector(sel) as HTMLElement
            ).shadowRoot?.activeElement?.classList.contains('de-editing-surface') ?? false,
          editor,
        ),
      )
      .toBe(true);
  });
});
