/**
 * The catch-up in the browser (HIS-028): the header control shows the count when there is activity
 * and nothing when there is none; the pane lists what is for the user first, the summary per region
 * and the changes, announces the number of changes in a polite live region, is operable by keyboard
 * with a visible focus, moves the marker to the head when the user dismisses it or leaves, and
 * passes axe. Run from the repository root:
 * `DOCEDIT_UI_PORT=57580 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts his-028-catch-up`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, focused, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="catch-up"]';
const OPTIONS = { headerPanes: true, features: ['history'], people: 'host' } as const;

const log = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __catchUpLog: { marked: number[]; loads: number } }).__catchUpLog,
  );

test.describe('the catch-up (HIS-028)', () => {
  test('the header control shows the count when the document opens, and the pane lists what is for the user first', async ({
    page,
  }) => {
    const h = await open(page, { ...OPTIONS, catchUp: 'full' });
    // 3 changes, 1 comment and 1 task are waiting.
    const control = page.getByRole('button', { name: 'Catch up, 5 changes since your last visit' });
    await expect(control).toBeVisible();
    expect(await h.exec('view.catchUp')).toMatchObject({ ran: true });
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    // For you comes first, and the mention before the task, whatever the service's order.
    const sections = pane.locator('[data-catch-up]');
    await expect(sections.first()).toHaveAttribute('data-catch-up', 'for-you');
    const forYou = pane.locator('[data-for-you]');
    await expect(forYou.first()).toHaveAttribute('data-for-you', 'mention');
    await expect(forYou.first()).toContainText('Grace Hopper mentioned you');
    await expect(forYou.nth(1)).toHaveAttribute('data-for-you', 'task');
    // The summary per region and the list of changes.
    await expect(pane.locator('[data-catch-up="summary"]')).toContainText('Summary: 2 changes');
    await expect(pane.locator('[data-catch-up="summary"]')).toContainText(
      'Outside regions: 1 change',
    );
    await expect(pane.locator('[data-catch-up="changes"] li')).toHaveCount(3);
    await expect(pane.locator('[data-catch-up="changes"]')).toContainText('by Ada Lovelace');
    // Markup in a comment shows as text.
    await expect(forYou.first()).toContainText('<b>this</b>');
    expect(await axe(page)).toEqual([]);
  });

  test('announces the number of changes in a polite live region', async ({ page }) => {
    const h = await open(page, { ...OPTIONS, catchUp: 'full' });
    await h.exec('view.catchUp');
    const live = page.locator(`${PANE} [data-catch-up-announce]`);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveText('3 changes since your last visit.');
  });

  test('is operable by keyboard: the button has a visible focus and moves the marker to the head', async ({
    page,
  }) => {
    await open(page, { ...OPTIONS, catchUp: 'full' });
    await page.getByRole('button', { name: /^Catch up/ }).focus();
    await page.keyboard.press('Enter');
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    const dismiss = pane.getByRole('button', { name: 'Mark as seen' });
    await dismiss.focus();
    // A visible focus indicator: an outline of at least 2 px.
    const outline = await dismiss.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await log(page)).marked).toEqual([9]);
    // The pane now says nothing is waiting, the header has no badge, and focus is in the pane.
    await expect(pane.locator('[data-status="empty"]')).toContainText('Nothing has changed');
    await expect(page.getByRole('button', { name: 'Catch up', exact: true })).toBeVisible();
    expect((await focused(page)).tag).toBe('h2');
  });

  test('leaving the pane with Escape moves the marker, and a later visit shows only newer activity', async ({
    page,
  }) => {
    const h = await open(page, { ...OPTIONS, catchUp: 'full' });
    await h.exec('view.catchUp');
    await expect(page.locator(PANE)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(PANE)).toHaveCount(0);
    await expect.poll(async () => (await log(page)).marked).toEqual([9]);
    // A later visit: the pane opens and has nothing to offer.
    await h.exec('view.catchUp');
    await expect(page.locator(`${PANE} [data-status="empty"]`)).toBeVisible();
    await expect(page.locator(`${PANE} [data-catch-up="changes"]`)).toHaveCount(0);
    expect((await log(page)).marked).toEqual([9]);
  });

  test('does not move the marker when the user has not viewed the head', async ({ page }) => {
    const h = await open(page, { ...OPTIONS, catchUp: 'not-viewed' });
    await h.exec('view.catchUp');
    await expect(page.locator(PANE)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(PANE)).toHaveCount(0);
    expect((await log(page)).marked).toEqual([]);
  });

  test('without activity the control shows no badge and the pane offers nothing', async ({
    page,
  }) => {
    const h = await open(page, { ...OPTIONS, catchUp: 'empty' });
    await expect(page.getByRole('button', { name: 'Catch up', exact: true })).toBeVisible();
    await expect(
      page.locator('.de-header-actions [data-command-id="view.catchUp"] .de-count'),
    ).toHaveCount(0);
    await h.exec('view.catchUp');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="empty"]')).toContainText('Nothing has changed');
    await expect(pane.locator('[data-catch-up]')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test('shows an error with a retry when the activity cannot be loaded', async ({ page }) => {
    const h = await open(page, { ...OPTIONS, catchUp: 'failing' });
    await h.exec('view.catchUp');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-status="error"]')).toContainText('could not be loaded');
    await pane.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(async () => (await log(page)).loads).toBeGreaterThan(2);
  });
});
