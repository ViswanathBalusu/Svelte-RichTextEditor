/**
 * UX-009 on the mounted element (lane w3): the format painter runs on the product's own core, not a
 * harness core. Armed by the keyboard from a bold selection, applied to another selection with
 * Enter, which makes that text bold and keeps its words; for a viewer the painter may be armed
 * but applying changes nothing and the shell says why. Uses the embed page and its in-memory
 * backend.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name: string) => `doc-editor[data-test="${name}"]`;
const surface = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-editing-surface`);
const ARM = process.platform === 'darwin' ? 'Meta+Shift+C' : 'Control+Shift+C';
const BOLD = 'strong, b, [data-mark="bold"]';

/** Selects the text of a paragraph, from its end back to its start, by the keyboard. */
async function selectParagraph(page: Page, name: string, text: string): Promise<void> {
  await surface(page, name).locator('p', { hasText: text }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
}

test.describe('UX-009 the format painter on the mounted element', () => {
  test('armed from a bold selection, Enter makes the next selection, bold and keeps its words', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const host = page.locator(editor('one'));
    const first = surface(page).locator('p').first();
    const words = await first.innerText();
    expect(words.length).toBeGreaterThan(0);
    await expect(first.locator(BOLD)).toHaveCount(0);

    // The source: the last paragraph, made bold.
    await selectParagraph(page, 'one', 'Last paragraph.');
    await page.keyboard.press('Control+B');
    await expect(
      surface(page).locator('p', { hasText: 'Last paragraph.' }).locator(BOLD).first(),
    ).toBeVisible();

    await page.keyboard.press(ARM);
    const button = host.locator('[data-command-id="format.painter"]');
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    // The target: the first paragraph, reached and selected by the keyboard alone. Enter applies; the
    // painter is off afterwards.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(first.locator(BOLD).first()).toBeVisible();
    expect(await first.innerText()).toBe(words);
  });

  test('Escape turns the painter off and changes nothing', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const host = page.locator(editor('one'));
    await selectParagraph(page, 'one', 'Last paragraph.');
    await page.keyboard.press('Control+B');
    await page.keyboard.press(ARM);
    const button = host.locator('[data-command-id="format.painter"]');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(surface(page).locator('p').first().locator(BOLD)).toHaveCount(0);
  });

  test('a viewer changes nothing, and the shell says why', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'two', sub: 'victor', role: 'viewer', target: 'mount-2' });
    const host = page.locator(editor('two'));
    const before = await surface(page, 'two').innerHTML();
    await selectParagraph(page, 'two', 'Last paragraph.');
    await page.keyboard.press(ARM);
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Enter');
    await expect(host.locator('[role="status"]').first()).toHaveText('This document is read-only.');
    expect(await surface(page, 'two').innerHTML()).toBe(before);
  });
});
