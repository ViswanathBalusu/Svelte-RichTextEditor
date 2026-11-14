/**
 * FE-104 criterion 5, extended to the states that the default-shell measurement
 * (fe-104-target-size.spec.ts) left out (lane U-FE-097-112): the command search, a shell dialog
 * (the language dialog) and the context menu. Each pointer-operated control of the shell in that
 * state is at least 24 by 24 CSS pixels in its bounding box (WCAG 2.2 criterion 2.5.8, the minimum;
 * the spacing exception is not used). Inline targets in the document's text are left out, as in
 * fe-104-target-size.spec.ts. Measured on the embed page in the element's shadow root.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=56061 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-104-target-size-states.spec.ts --project=chromium --project=firefox --project=webkit --workers=1 --retries=0 --output=<scratchpad folder>`.
 *
 * Handles (criteria 1 to 4, the drag alternatives) are not built, so they are not measured here.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';
import { record } from './helpers.ts';

interface Small {
  label: string;
  width: number;
  height: number;
}

interface Measure {
  count: number;
  small: Small[];
}

const SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="combobox"], [role="switch"], [role="option"], input, select, a[href]';

/** Measures every visible pointer control in the editor's shadow root (outside the document's text). */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate((selector) => {
    const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
    const found = [...root.querySelectorAll(selector)]
      .filter((el) => !el.closest('.de-editing-surface, .de-sub-editor'))
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label =
          el.getAttribute('aria-label') ??
          el.getAttribute('title') ??
          el.textContent?.trim() ??
          el.tagName;
        return {
          label: `${el.tagName.toLowerCase()} ${label.slice(0, 40)}`,
          width: rect.width,
          height: rect.height,
        };
      });
    return {
      count: found.length,
      small: found.filter((t) => t.width < 24 || t.height < 24),
    };
  }, SELECTOR);
}

test.describe('pointer targets in the shell states (FE-104 criterion 5)', () => {
  test('the command search and the language dialog: every control is at least 24 by 24', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const editor = page.locator('doc-editor[data-test="one"]');
    const surface = editor.locator('.de-editing-surface').first();
    await surface.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Alt+q');
    const search = editor.locator('input[role="combobox"]').first();
    await expect(search).toBeVisible();
    const searchState = await measure(page);
    await search.fill('language');
    await page.keyboard.press('Enter');
    await expect(editor.locator('[role="dialog"], dialog[open]').first()).toBeVisible();
    const dialogState = await measure(page);

    record('fe-104-target-size-states', { commandSearch: searchState, dialog: dialogState });
    expect(searchState.count).toBeGreaterThan(0);
    expect(dialogState.count).toBeGreaterThan(0);
    expect(searchState.small).toEqual([]);
    expect(dialogState.small).toEqual([]);
  });

  test('the context menu: every control is at least 24 by 24', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const editor = page.locator('doc-editor[data-test="one"]');
    const surface = editor.locator('.de-editing-surface').first();
    await surface.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Shift+F10');
    const menu = editor.locator('[role="menu"], [role="menuitem"]').first();
    await expect(menu).toBeVisible();
    const menuState = await measure(page);

    record('fe-104-target-size-context-menu', { contextMenu: menuState });
    expect(menuState.count).toBeGreaterThan(0);
    expect(menuState.small).toEqual([]);
  });
});
