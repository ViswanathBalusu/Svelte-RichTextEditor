/**
 * FE-135, criterion 4: inserting a footnote gives it the next number, and the footnote opens in the
 * footnote panel. The footnote is inserted with the editor's own Insert footnote button on the S1
 * page (the element's real command path). The refusal of a footnote in a footnote or a caption is
 * covered by the engine's module tests, not here. Run with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-135-footnote.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

test.describe('insert a footnote (FE-135 criterion 4)', () => {
  test('the new footnote takes the next number and opens in the panel', async ({ page }) => {
    const h = await openS1(page, '?model=paragraph');
    // The S1 document has one footnote, numbered 1 in the body.
    const numbers = () =>
      page.evaluate(() => {
        const root = document.querySelector('doc-editor')!.shadowRoot!;
        return [...root.querySelectorAll('.de-editing-surface [data-n]')].map((el) => ({
          n: el.getAttribute('data-n'),
          label: el.getAttribute('aria-label'),
        }));
      });
    expect(await numbers()).toEqual([{ n: '1', label: 'Footnote 1' }]);

    await h.caretIn(SPIKE_IDS.last, 'end');
    await page.locator('doc-editor button[data-command="insertFootnote"]').click();
    await page.locator('doc-editor .de-sub-editor').waitFor();
    await expect.poll(() => h.subMounted()).toBe(true);

    // The new footnote is the second in the body, after the first.
    expect(await numbers()).toEqual([
      { n: '1', label: 'Footnote 1' },
      { n: '2', label: 'Footnote 2' },
    ]);
    // It opened in the footnote panel, and typing goes into it.
    await page.keyboard.type('New note');
    await expect.poll(() => h.subText()).toBe('New note');
    expect(await h.footnotes()).toHaveLength(2);
    expect((await h.footnotes()).map((f) => f.text)).toEqual(['Footnote text', 'New note']);
    expect((await h.validate()).violations).toEqual([]);
  });
});
