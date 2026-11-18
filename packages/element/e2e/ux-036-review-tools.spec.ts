/**
 * The review tools in the production element (UX-036 criterion 1; lane w3). The real element runs
 * with its demo backend. A suggestion typed in review mode is found with the registry's
 * `review.previous`, rejected with `review.reject`, and another one is accepted with
 * `review.accept` at the caret. The commit origins are checked against the authority's room in
 * packages/engine/test/ux-036-review.test.ts. Run with
 * `DOCEDIT_DEMO_PORT=57341 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-036-review-tools.spec.ts --project=<browser>`.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

const run = (page: Page, command: string) =>
  page.evaluate(
    ([sel, name]) =>
      (document.querySelector(sel!) as unknown as { exec(name: string): boolean }).exec(name!),
    [EDITOR, command],
  );

test.describe('review tools in the element (UX-036)', () => {
  test('previous finds a suggestion, reject removes it, accept keeps another, each as a change of the document', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { mode: 'review' });
    const surface = page.locator(`${EDITOR} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('ZZ');
    await expect(surface.locator('.de-suggest-ins')).toHaveText('ZZ');
    // A second suggestion in the first paragraph.
    await surface.locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('QQ');
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(2);

    // The commands are offered: next, from the caret after the second words, reaches the later suggestion.
    expect(await run(page, 'review.next')).toBe(true);
    const selected = await page.evaluate(() => getSelection()?.toString() ?? '');
    expect(selected).toBe('ZZ');
    // Reject it: the words go, the other suggestion stays.
    expect(await run(page, 'review.reject')).toBe(true);
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(1);
    await expect(surface).not.toContainText('ZZ');
    // Previous, from where the rejected words were, finds the first suggestion; accept it: the mark goes, the words stay.
    expect(await run(page, 'review.previous')).toBe(true);
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('QQ');
    expect(await run(page, 'review.accept')).toBe(true);
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(0);
    await expect(surface).toContainText('QQ');
    // With none left the step commands say so and do nothing.
    expect(await run(page, 'review.next')).toBe(false);
  });
});
