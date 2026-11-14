/**
 * UX-007, criterion 6: switching the `toolbar` attribute between `full` and `compact` while a
 * document is open leaves the selection, the scroll position of the page and unsent input
 * untouched. The harness page is made taller than the frame so that the document scrolls; the
 * unsent input is a query typed into the command search field, which stays open across the
 * switch and is not run. Lane V-UX-001-015. Run with `DOCEDIT_UI_PORT=57250 pnpm exec playwright
 * test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-007-layout-switch.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

/** Makes the body taller than the frame, so that the document scrolls. */
async function makeTall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const body = document
      .getElementById('host')!
      .shadowRoot!.querySelector('.de-body-host') as HTMLElement;
    body.style.minBlockSize = '4000px';
  });
}

async function setScrollTop(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => window.scrollTo(0, v), value);
  await page.waitForFunction((v) => window.scrollY === v, value);
}

async function surfaceHtml(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      document.getElementById('host')!.shadowRoot!.querySelector('.de-editing-surface')!.innerHTML,
  );
}

test.describe('switching the layout keeps the view (UX-007, criterion 6)', () => {
  test('selection, page scroll position and unsent input are untouched by a switch', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'full', extended: true });
    await makeTall(page);
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: ['italic'] });

    // Unsent input: a query typed into command search, not run.
    await page.keyboard.press('Alt+q');
    const field = page.getByRole('combobox', { name: 'Command name' });
    await expect(field).toBeFocused();
    await page.keyboard.type('bold');
    await expect(field).toHaveValue('bold');

    // Scroll after the search opens, so that the position is one the user chose.
    await setScrollTop(page, 300);
    const before = {
      selection: await h.selection(),
      scroll: await page.evaluate(() => window.scrollY),
      surface: await surfaceHtml(page),
    };
    expect(before.scroll).toBe(300);

    await h.setSettings({ toolbar: 'compact' });
    await expect(page.getByRole('toolbar', { name: 'Editing' })).toBeVisible();
    await h.setSettings({ toolbar: 'full' });
    await expect(page.getByRole('tablist')).toBeVisible();

    expect(await h.selection()).toEqual(before.selection);
    expect(await page.evaluate(() => window.scrollY)).toBe(before.scroll);
    expect(await surfaceHtml(page)).toBe(before.surface);
    await expect(page.getByRole('combobox', { name: 'Command name' })).toHaveValue('bold');
    expect((await h.calls()).filter((c) => c === 'mountBody')).toHaveLength(1);
    // Nothing ran: the unsent query is still unsent.
    expect(await h.runs()).toEqual([]);
    // Focus stays in the search field: the switch does not move it.
    await expect(page.getByRole('combobox', { name: 'Command name' })).toBeFocused();
  });
});
