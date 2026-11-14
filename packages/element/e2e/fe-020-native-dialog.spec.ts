/**
 * FE-020 criterion 1, native dialogs (lane V-FE-017-032). The shell's `Dialog.svelte` dialogs (here
 * the language dialog, command `format.language`) are opened through the command search (Alt+Q),
 * the way fe-126-dialogs-axe.spec.ts does. The dialog must live in the element's shadow root, the
 * host page's body and head must keep their child counts, and no `dialog` may appear in the light
 * DOM. Runs in every project of the element's Playwright config.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-020-native-dialog.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe020-native
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const dialogSel = '[role="dialog"], dialog[open]';

const hostCounts = (page: Page) =>
  page.evaluate(() => ({
    body: document.body.childElementCount,
    head: document.head.childElementCount,
    lightDialogs: document.querySelectorAll('dialog, [role="dialog"]').length,
  }));

test.describe('FE-020 criterion 1: a native shell dialog lives in the shadow root', () => {
  test('the language dialog is in the shadow root and nothing is appended to the host page', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const surface = page.locator(`${editor} .de-editing-surface`);
    await expect(surface).toHaveAttribute('contenteditable', 'true');

    const before = await hostCounts(page);
    await surface.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Alt+q');
    const search = page.locator(`${editor} input[role="combobox"]`).first();
    await expect(search).toBeVisible();
    await search.fill('language');
    await page.keyboard.press('Enter');

    const dialog = page.locator(`${editor} ${dialogSel}`).first();
    await expect(dialog).toBeVisible();

    const placed = await page.evaluate(
      ({ sel, dialogSel }) => {
        const host = document.querySelector(sel) as HTMLElement;
        return {
          inShadow: host.shadowRoot?.querySelectorAll(dialogSel).length ?? 0,
          inLightDom: document.querySelectorAll(dialogSel).length,
        };
      },
      { sel: editor, dialogSel },
    );
    expect(placed.inShadow).toBeGreaterThan(0);
    expect(placed.inLightDom).toBe(0);

    const after = await hostCounts(page);
    expect(after.body).toBe(before.body);
    expect(after.head).toBe(before.head);
    expect(after.lightDialogs).toBe(0);
  });
});
