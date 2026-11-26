/**
 * Tracked changes for everyone through the product (UX-038; owner decision 118): two real
 * `<doc-editor>` elements on one document of the embed page's mock backend, the first as its
 * owner (`manage`) and the second as an editor. The owner turns the setting on in the review pane;
 * the editor's element, never reloaded, shows review mode with the reason, and what the editor types
 * is recorded as a suggestion; the editor's pane offers no switch and says who may switch it off.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-038-tracked-for-everyone.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

function exec(page: Page, name: string, command: string): Promise<unknown> {
  return page.evaluate(
    ([n, c]) =>
      (
        document.querySelector('doc-editor[data-test="' + n + '"]') as unknown as {
          exec(command: string): unknown;
        }
      ).exec(c!),
    [name, command],
  );
}

/** How many suggested insertions the element's document holds. */
function insertions(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) =>
      (
        document.querySelector('doc-editor[data-test="' + n + '"]') as unknown as {
          getContent(): Promise<{ doc: unknown }>;
        }
      )
        .getContent()
        .then((c) => (JSON.stringify(c.doc).match(/"type":"ins"/g) ?? []).length),
    name,
  );
}

test('the owner turns it on, the editor is in review mode at once, and off again (UX-038 criteria 1 to 3 and 5)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada', role: 'owner' });
  await mountEditor(page, { name: 'two', sub: 'bob', role: 'editor', target: 'mount-2' });
  const one = page.locator('doc-editor[data-test="one"]');
  const two = page.locator('doc-editor[data-test="two"]');

  // The editor's own pane: the setting is off, and there is no switch for an editor (criterion 2).
  expect(await exec(page, 'two', 'view.review')).toMatchObject({ ok: true });
  const paneTwo = two.locator('.de-pane[data-pane="review"]');
  await expect(paneTwo.locator('[data-tracked-state]')).toContainText('are off');
  await expect(paneTwo.getByRole('checkbox', { name: 'Track changes for everyone' })).toHaveCount(
    0,
  );
  await expect(two.locator('.de-mode-button')).toHaveAttribute('data-mode', 'edit');

  // The owner turns it on.
  expect(await exec(page, 'one', 'view.review')).toMatchObject({ ok: true });
  const box = one
    .locator('.de-pane[data-pane="review"]')
    .getByRole('checkbox', { name: 'Track changes for everyone' });
  await box.check();
  await expect(one.locator('.de-mode-button')).toHaveAttribute('data-mode', 'review');

  // The editor's element follows without a reload (criterion 3), says so and says who may undo it.
  await expect(two.locator('.de-mode-button')).toHaveAttribute('data-mode', 'review');
  await expect(two.locator('.de-mode-reason')).toBeVisible();
  await expect(paneTwo.locator('[data-tracked-state]')).toContainText('are on');
  await expect(paneTwo.locator('[data-tracked-who]')).toContainText('right to manage');

  // What the editor types is a suggestion (criterion 1).
  const before = await insertions(page, 'two');
  await two.locator('.de-editing-surface p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('Q');
  await expect.poll(() => insertions(page, 'two')).toBeGreaterThan(before);

  // The owner turns it off; the editor edits directly again, in the same page.
  await box.uncheck();
  await expect(two.locator('.de-mode-button')).toHaveAttribute('data-mode', 'edit');
  await expect(paneTwo.locator('[data-tracked-state]')).toContainText('are off');
});
