/**
 * The review pane in the production element (UX-037 criteria 1 to 5 in part; lane w3). The real
 * element runs with its demo backend. Suggestions typed in review mode are listed by the pane with
 * their kind, author and words; the filter narrows the list; Show moves the selection to a
 * suggestion; Accept and Reject on an item resolve that one, and the list follows. Run with
 * `DOCEDIT_DEMO_PORT=57345 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-037-review-pane.spec.ts`.
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

test.describe('the review pane in the element (UX-037)', () => {
  test('lists the suggestions, shows one, accepts and rejects from the items, and follows the core', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { mode: 'review' });
    const surface = page.locator(`${EDITOR} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('ZZ');
    await surface.locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('QQ');
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(2);

    expect(await run(page, 'view.review')).toBe(true);
    const pane = page.locator(`${EDITOR} .de-pane[data-pane="review"]`);
    await expect(pane).toBeVisible();
    const rows = pane.locator('li[data-suggestion]');
    await expect(rows).toHaveCount(2);
    // Document order: QQ is in the first paragraph, ZZ in the last.
    await expect(rows.nth(0).locator('.de-review-excerpt')).toHaveText('QQ');
    await expect(rows.nth(1).locator('.de-review-excerpt')).toHaveText('ZZ');
    await expect(rows.nth(0).locator('.de-review-kind')).toHaveText('Insertion');
    await expect(rows.nth(0).locator('.de-review-author')).not.toHaveText('');
    await expect(rows.nth(0).locator('.de-review-head')).toHaveAccessibleName(
      /^Insertion by .+: QQ$/,
    );

    // Show moves the selection to the suggestion's words.
    await rows.nth(1).locator('[data-review-show]').click();
    // The core's selection is the suggestion's words (focus stays on the button, so the DOM selection is not).
    const selected = await page.evaluate((sel) => {
      const hooks = (globalThis as unknown as { __embed: { internals(el: Element): unknown } })
        .__embed;
      const core = (
        hooks.internals(document.querySelector(sel)!) as {
          editor: { core: { getSelectionContent(): unknown } };
        }
      ).editor.core;
      return JSON.stringify(core.getSelectionContent());
    }, EDITOR);
    expect(selected).toContain('ZZ');
    expect(selected).not.toContain('QQ');
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');

    // Reject on the item removes its words and the row; Accept on the other keeps its words.
    await rows.nth(1).locator('[data-review-reject]').click();
    await expect(rows).toHaveCount(1);
    await expect(surface).not.toContainText('ZZ');
    await rows.nth(0).locator('[data-review-accept]').click();
    await expect(rows).toHaveCount(0);
    await expect(surface).toContainText('QQ');
    await expect(surface.locator('.de-suggest-ins')).toHaveCount(0);
    await expect(pane.getByText('There are no suggestions to show.')).toBeVisible();
  });
});
