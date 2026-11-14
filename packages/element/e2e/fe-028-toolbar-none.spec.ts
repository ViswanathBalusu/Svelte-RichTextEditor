/**
 * FE-028 criterion 5 (lane U-FE-017-032): a host with `toolbar="none"` renders its own bold button
 * from `queryCommand` and the `de-command-state` event, and the button stays in sync as the caret
 * moves in and out of bold text. Uses the embed page and its in-memory backend. Run in Chromium
 * (see the story's evidence for the browsers actually run).
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);

/** A host button, outside the element, that mirrors the bold command state. */
async function installHostBold(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement & {
      queryCommand(name: string): { enabled: boolean; active: boolean };
    };
    const button = document.createElement('button');
    button.id = 'host-bold';
    button.type = 'button';
    button.textContent = 'Bold';
    button.setAttribute('aria-pressed', 'false');
    document.body.append(button);
    const sync = (): void => {
      button.setAttribute('aria-pressed', String(el.queryCommand('bold').active));
    };
    el.addEventListener('de-command-state', sync);
    sync();
  }, editor);
}

const pressed = (page: Page) => page.locator('#host-bold').getAttribute('aria-pressed');

test.describe('FE-028 the host toolbar mirrors bold from de-command-state', () => {
  test('a toolbar="none" host button follows the caret into and out of bold text', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { toolbar: 'none' } });
    await expect(page.locator(`${editor}`)).toHaveAttribute('toolbar', 'none');
    await installHostBold(page);
    await expect.poll(() => pressed(page)).toBe('false');

    // Select the last paragraph and make it bold: the host button turns pressed.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Control+B');
    await expect.poll(() => pressed(page)).toBe('true');

    // Move the caret out of the bold text, into the plain first paragraph: pressed turns off.
    await surface(page).locator('p').first().click();
    await page.keyboard.press('Home');
    await expect.poll(() => pressed(page)).toBe('false');

    // And back into the bold text: pressed turns on again.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await expect.poll(() => pressed(page)).toBe('true');
  });
});
