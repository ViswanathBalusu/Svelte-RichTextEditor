/**
 * UX-018 on the mounted element (lane w3): the status bar's word count follows the body of the real
 * document, and the language dialog sets the `lang` mark through the editing core, with the bar
 * showing the language at the caret. Uses the embed page and its in-memory backend.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name: string) => `doc-editor[data-test="${name}"]`;
const surface = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-editing-surface`);
const words = (page: Page, name = 'one') =>
  page.locator(`${editor(name)} .de-status [data-status="words"]`);
const language = (page: Page, name = 'one') =>
  page.locator(`${editor(name)} .de-status [data-status="language"]`);

async function wordCount(page: Page): Promise<number> {
  // "12 words": the digits are the count (a thousands separator in the locale is not a digit).
  return Number((await words(page).innerText()).replace(/\D/g, ''));
}

test.describe('UX-018 the status bar on the mounted element', () => {
  test('the word count is of the body and follows typing a little after it', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(words(page)).toBeVisible();
    const start = await wordCount(page);
    expect(start).toBeGreaterThan(0);

    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    const typed = ' one two three four five six seven eight nine ten';
    await page.keyboard.type(typed, { delay: 0 });
    // Every key reached the document at once: the count does not hold typing back.
    await expect(surface(page).locator('p', { hasText: 'Last paragraph.' })).toContainText(
      typed.trim(),
    );
    await expect.poll(() => wordCount(page), { timeout: 5_000 }).toBe(start + 10);

    // Deleting them brings it back.
    for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
    await expect.poll(() => wordCount(page), { timeout: 5_000 }).toBe(start);
  });

  test('the language dialog sets the language of the selection and the bar shows it at the caret', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const last = surface(page).locator('p', { hasText: 'Last paragraph.' });
    // A triple click selects the paragraph's text in every browser.
    await last.click({ clickCount: 3 });
    await language(page).click();
    const dialog = page.getByRole('dialog', { name: 'Language of the selected text' });
    await expect(dialog).toBeVisible();
    // No language mark yet, so the dialog offers the document's own language first.
    await dialog.getByRole('checkbox', { name: 'Use the language of the document' }).uncheck();
    await dialog.getByRole('textbox', { name: 'Language tag' }).fill('fr');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(language(page)).toHaveText('Language: French');
    await expect(last.locator('[lang="fr"]').first()).toBeVisible();

    // Elsewhere the bar shows the document's own language, not French.
    await surface(page).locator('p').first().click();
    await expect(language(page)).not.toHaveText('Language: French');
    // Back in the French text it shows French again.
    await last.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(language(page)).toHaveText('Language: French');
  });

  test('a viewer cannot change the language, and the command says so', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'two', sub: 'victor', role: 'viewer', target: 'mount-2' });
    await expect(language(page, 'two')).toHaveAttribute('aria-disabled', 'true');
    await expect(words(page, 'two')).toBeVisible();
  });
});
