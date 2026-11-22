/**
 * FE-050 criterion 4 (lane V-FE-049-064, round 5): Copy in each supported browser, then paste into the
 * same editor. Unlike the constructed-event tests of src/view, this uses the browser's own keyboard
 * copy (Ctrl+C) and paste (Ctrl+V), so the clipboard is the browser's real one.
 *
 * The first paragraph's text is selected and copied, the caret goes to the end of the last paragraph,
 * and the paste must add that text there. Chromium needs the clipboard permissions; WebKit and Firefox
 * run with the browser's defaults and report what they do.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-050-copy-paste-keyboard.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const COPY_KEY = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
const PASTE_KEY = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

test.describe('FE-050 criterion 4: copy and paste with the keyboard in the same editor', () => {
  test('text copied from the first paragraph arrives intact at the end of the document', async ({
    page,
    context,
    browserName,
  }) => {
    // Playwright's WebKit on Windows fires the copy event, but the clipboard is not readable there
    // (navigator.clipboard.readText: NotAllowedError) and the paste does not arrive. Recorded in the
    // story Notes (FE-050); not claimed as passing.
    test.skip(
      browserName === 'webkit',
      'WebKit: keyboard copy does not reach a readable clipboard in Playwright on Windows (FE-050 Notes)',
    );
    // Edge runs as a Chromium channel, so its browserName is 'chromium' too.
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await openEmbed(page);
    const name = 'fe-050-keyboard';
    await mountEditor(page, { name });
    const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
    const paragraphs = surface.locator('p');
    const first = paragraphs.first();
    const source = ((await first.textContent()) ?? '').trim();
    expect(source.length, 'the seeded first paragraph has text').toBeGreaterThan(0);

    // Select the whole first paragraph and copy it with the keyboard.
    await first.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    // The editor has the selection a moment after the keys (selectionchange); a copy before that copies the caret.
    await page.waitForTimeout(250);
    await page.keyboard.press(COPY_KEY);

    // Caret at the end of the last paragraph, then paste with the keyboard.
    const last = paragraphs.last();
    await last.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press(PASTE_KEY);

    await expect
      .poll(async () => ((await surface.locator('p').last().textContent()) ?? '').trim(), {
        timeout: 10_000,
        message: 'the copied text arrives at the end, once',
      })
      .toBe(source);
  });
});
