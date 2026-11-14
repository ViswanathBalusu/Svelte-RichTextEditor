/**
 * FE-020 criterion 2 (lane V-FE-017-032): where the Popover API is missing, the context menu still
 * opens and is positioned. The spec removes `showPopover` and `hidePopover` from HTMLElement before
 * any page script runs, so the menu takes the fallback path (no `popover` attribute, shown by the
 * `.de-context-menu:not([popover])` rule). Checks: the menu is visible, inside the viewport, has no
 * `popover` attribute, lives in the shadow root, and Escape closes it with focus back in the editor.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-020-popover-fallback.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe020-fallback
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const menu = (page: Page) => page.locator(`${editor} .de-context-menu`);

test.describe('FE-020 criterion 2: the context menu opens without the Popover API', () => {
  test('the fallback opens, places and closes the menu', async ({ page }) => {
    await page.addInitScript(() => {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      delete proto['showPopover'];
      delete proto['hidePopover'];
      delete proto['togglePopover'];
    });
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');

    const supported = await page.evaluate(() => 'showPopover' in HTMLElement.prototype);
    expect(supported).toBe(false);

    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Shift+F10');

    await expect(menu(page)).toBeVisible();
    const state = await page.evaluate((sel) => {
      const host = document.querySelector(sel) as HTMLElement;
      const node = host.shadowRoot!.querySelector('.de-context-menu') as HTMLElement;
      const rect = node.getBoundingClientRect();
      return {
        hasPopoverAttribute: node.hasAttribute('popover'),
        inLightDom: document.querySelectorAll('.de-context-menu').length,
        inViewport:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
      };
    }, editor);
    expect(state).toEqual({ hasPopoverAttribute: false, inLightDom: 0, inViewport: true });

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
