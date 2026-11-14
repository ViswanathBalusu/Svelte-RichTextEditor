/**
 * FE-029 criterion 2 (lane U-FE-017-032): in `mode="view"` the editing surface takes no text input
 * or structural edits, while selection and copying still work. Uses the embed page and its
 * in-memory backend, as mode.spec.ts does. Run in Chromium only (see the evidence on the story):
 * the selection check reads `window.getSelection()` across the shadow boundary.
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const surface = (page: Page) => page.locator('doc-editor[data-test="one"] .de-editing-surface');

test.describe('FE-029 view mode: selection and copy still work, input does not', () => {
  test('a view-mode surface selects text and copies it, and refuses typing', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', mode: 'view' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');

    // Count copy events that reach the document (copy is composed, so they cross the shadow root).
    await page.evaluate(() => {
      const w = window as unknown as { __copies: number };
      w.__copies = 0;
      document.addEventListener('copy', () => {
        w.__copies += 1;
      });
    });

    // Selection: a click and Shift+End select the paragraph text in the browser's selection.
    // A non-editable surface takes a pointer selection, not keyboard extension: drag across the
    // paragraph from its first to its last character.
    const paragraph = surface(page).locator('p', { hasText: 'Last paragraph.' });
    const box = (await paragraph.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    // The selection inside the open shadow root (ShadowRoot.getSelection is a Chromium API).
    const selected = await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
      const sel = (root as unknown as { getSelection?: () => Selection | null }).getSelection?.();
      return sel?.toString() ?? '';
    });
    expect(selected).toContain('Last paragraph.');

    // Copy: the browser copy command fires a copy event that reaches the document.
    await page.keyboard.press('Control+C');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copies: number }).__copies))
      .toBeGreaterThan(0);

    // Input: typing reaches nothing in view mode, and the document keeps its text.
    const before = await bodyText(page);
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Refused');
    expect(await bodyText(page)).toBe(before);
    expect(await bodyText(page)).not.toContain('Refused');
  });
});
