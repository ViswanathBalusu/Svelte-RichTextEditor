/**
 * The history pane in the browser (HIS-009): it opens from the command registry only with the
 * history port, lists groups and named versions with the names the directory gives, shows an
 * erased person as unknown, shows markup as text, narrows with the named-versions filter, explains
 * the restriction for a reader of named versions, shows an error with a retry, and passes axe.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57570 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts his-009-history-pane`.
 */
import { axe, expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

test.describe('the history pane (HIS-009)', () => {
  test('is offered from the command registry, and lists groups and named versions with names', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    expect(await h.exec('view.history')).toMatchObject({ ran: true });
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    const group = pane.locator('[data-history="group"]').first();
    await expect(group).toContainText('Ada Lovelace');
    await expect(group).toContainText('3 changes');
    await expect(group).toContainText('2026');
    await expect(pane.locator('[data-history="version"]')).toContainText('Named version');
    expect(await axe(page)).toEqual([]);
  });

  test('shows an erased person as unknown and markup in a name or note as text', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-history="group"]').first()).toContainText('Unknown person');
    const version = pane.locator('[data-history="version"]');
    await expect(version.locator('[data-content]').first()).toContainText('<img');
    await expect(version.locator('[data-content]').nth(1)).toContainText('<b>Before review</b>');
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
  });

  test('narrows to named versions with the keyboard, and shows the active filter', async ({
    page,
  }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    const named = pane.getByLabel('Named versions only');
    await named.focus();
    await page.keyboard.press('Space');
    await expect(named).toBeChecked();
    await expect(pane.locator('[data-history="group"]')).toHaveCount(0);
    await expect(pane.locator('[data-filter="named"]')).toHaveText('Named versions');
  });

  test('tells a reader of named versions why the rest is not shown', async ({ page }) => {
    const h = await open(page, { history: 'named', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="named-only"]')).toContainText(
      'You can see named versions only',
    );
    await expect(pane.locator('[data-history="group"]')).toHaveCount(0);
  });

  test('shows an error message with a retry when the history cannot be read', async ({ page }) => {
    const h = await open(page, { history: 'failing', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="error"]')).toContainText(
      'The history could not be loaded.',
    );
    await expect(pane.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('is not offered without the history port', async ({ page }) => {
    const h = await open(page, { features: ['history'], people: 'host' });
    expect(await h.exec('view.history')).toMatchObject({ ran: false });
    await expect(page.locator(PANE)).toHaveCount(0);
  });
});
