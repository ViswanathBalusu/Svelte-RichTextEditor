/**
 * UX-036 criterion 2, over a region (lane w3): in the production element with its demo backend, the
 * review pane filters the suggestions by region, and "Accept all in <region>" resolves the
 * suggestions of that region only, in one step, leaving the one in the body pending. Run with
 * `DOCEDIT_DEMO_PORT=57346 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-036-region-filter.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

const run = (page: Page, command: string) =>
  page.evaluate(
    ([sel, name]) =>
      (
        document.querySelector(sel!) as unknown as {
          exec(name: string): { ok: boolean };
        }
      ).exec(name!).ok,
    [EDITOR, command],
  );

test.describe('accept all over a region (UX-036 criterion 2)', () => {
  test('the region filter narrows the list and "Accept all in" leaves the body pending', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { mode: 'review' });
    const surface = page.locator(`${EDITOR} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Liability is limited' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('RR');
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('ZZ');
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(2);

    expect(await run(page, 'view.review')).toBe(true);
    const pane = page.locator(`${EDITOR} .de-pane[data-pane="review"]`);
    const rows = pane.locator('li[data-suggestion]');
    await expect(rows).toHaveCount(2);

    // With no filter the buttons act on the document and are named so.
    await expect(pane.locator('[data-review-accept-all]')).toHaveText('Accept all');

    // The region filter lists the region that holds a suggestion, by its title.
    const region = pane.getByLabel('Region');
    await expect(region.locator('option')).toHaveText(['The whole document', 'Legal review']);
    await region.selectOption({ label: 'Legal review' });
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('.de-review-excerpt')).toHaveText('RR');
    await expect(pane.locator('[data-review-accept-all]')).toHaveText('Accept all in Legal review');
    await expect(pane.locator('[data-review-reject-all]')).toHaveText('Reject all in Legal review');

    // Accepting over the region resolves its suggestion only.
    await pane.locator('[data-review-accept-all]').click();
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(1);
    await expect(surface).toContainText('RR');
    await expect(surface.locator('.de-suggest-ins')).toHaveText('ZZ');
    // The region has nothing left, so the filter falls back to the whole document: ZZ is listed.
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('.de-review-excerpt')).toHaveText('ZZ');
    await expect(region).toHaveCount(0);
  });
});
