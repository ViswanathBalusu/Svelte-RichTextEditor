/**
 * Command search (UX-011; 13 §2, §4): opened by its documented shortcut (Alt+Q), it lists the
 * offered commands by label, runs the chosen one, refuses one the permissions do not allow, lists
 * an extension command beside the built-in ones, and says "No results" when nothing matches.
 * Run with `DOCEDIT_UI_PORT=57250 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ux-011-command-search.spec.ts`.
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

const VIEW_ONLY = { scope: 'body', caps: ['view'], limit: 'role' } as const;

test.describe('command search (UX-011)', () => {
  test('opens with Alt+Q, lists matches, runs the chosen one and returns focus to the text', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    const field = page.getByRole('combobox', { name: 'Command name' });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.type('bold');
    const list = page.getByRole('listbox');
    await expect(list.locator('[data-command-id="format.bold"]')).toBeVisible();
    await expect(page.locator('[data-search-count]')).toHaveText(/\d+ results?/);
    // The first result is active, so Enter runs the best match.
    await expect(list.locator('[role="option"]').first()).toHaveAttribute('aria-selected', 'true');
    await expect(field).toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Enter');
    expect(await h.runs()).toEqual(['bold']);
    await expect(page.getByRole('combobox', { name: 'Command name' })).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('lists a command under a synonym from the locale table, and runs it (criterion 2)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    // "slant" is a synonym of Italic in the en-GB table (`synonyms.format.italic`), not in its label.
    await page.keyboard.type('slant');
    const list = page.getByRole('listbox');
    await expect(list.locator('[data-command-id="format.italic"]')).toBeVisible();
    await expect(list.locator('[role="option"]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    expect(await h.runs()).toEqual(['italic']);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('arrow keys move the active result, and a click runs a result', async ({ page }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('i');
    const options = page.getByRole('listbox').locator('[role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('listbox').locator('[data-command-id="format.italic"]').click();
    expect(await h.runs()).toEqual(['italic']);
    await expect(page.getByRole('combobox', { name: 'Command name' })).toHaveCount(0);
  });

  test('says "No results" and Enter runs nothing when nothing matches; Escape closes', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('zzqxv');
    await expect(page.locator('[data-search-count]')).toHaveText('No results');
    await expect(page.getByRole('listbox').locator('[role="option"]')).toHaveCount(0);
    await page.keyboard.press('Enter');
    expect(await h.runs()).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Command name' })).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('lists a command the permissions do not allow as disabled, and Enter runs nothing', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, access: VIEW_ONLY });
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('bold');
    const bold = page.getByRole('listbox').locator('[data-command-id="format.bold"]');
    await expect(bold).toHaveAttribute('aria-disabled', 'true');
    await expect(bold).toHaveAccessibleDescription(
      'You can view this part of the document but not change it.',
    );
    await page.keyboard.press('Enter');
    expect(await h.runs()).toEqual([]);
    await expect(page.getByRole('combobox', { name: 'Command name' })).toBeVisible();
  });

  test('lists an extension command beside the built-in ones', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.register('ext.stamp', 'command.format.bold', false, {});
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('bold');
    const list = page.getByRole('listbox');
    await expect(list.locator('[data-command-id="ext.stamp"]')).toHaveCount(1);
    await expect(list.locator('[data-command-id="format.bold"]')).toHaveCount(1);
  });
});
