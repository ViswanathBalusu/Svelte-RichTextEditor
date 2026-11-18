/**
 * Copying a version into a new document, from the history pane (HIS-022 criterion 1): with a host
 * that handles `de-fork-request`, an open version offers "Copy this version to a new document",
 * and choosing it hands the host the `seq` of the version and nothing else; the pane does not call
 * the fork itself (a service-credential operation). Without such a host the command is not offered.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57591 pnpm exec playwright test -c packages/ui/playwright.config.ts his-022`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

const forkRequests = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    (window as unknown as { harness: { forkRequests: number[] } }).harness.forkRequests.slice(),
  );

async function openVersion(page: Page, fork: boolean): Promise<void> {
  const h = await open(page, {
    history: 'versions',
    features: ['history'],
    people: 'host',
    fork,
  });
  await h.exec('view.history');
  await page.locator(`${PANE} [data-history="version"] [data-open-version]`).click();
  await expect(page.locator(`${PANE} [data-version-view]`)).toBeVisible();
}

test.describe('copy a version into a new document (HIS-022)', () => {
  test('hands the host the seq of the open version, and only that', async ({ page }) => {
    await openVersion(page, true);
    const button = page.locator(`${PANE} [data-version-view] [data-fork-request]`);
    await expect(button).toHaveText('Copy this version to a new document');
    expect(await forkRequests(page)).toEqual([]);
    await button.click();
    // The named version in the harness is at seq 12.
    expect(await forkRequests(page)).toEqual([12]);
    // The shell says it asked, in words.
    await expect(
      page.locator('[role="status"]', { hasText: 'Asked to copy this version' }).first(),
    ).toBeAttached();
    // No request went to the harness backend: the pane never calls the fork itself.
    expect(
      await page.evaluate(
        () => (window as unknown as { __versionLog: { closed: number } }).__versionLog.closed,
      ),
    ).toBe(0);
  });

  test('is a button the keyboard reaches', async ({ page }) => {
    await openVersion(page, true);
    const button = page.locator(`${PANE} [data-version-view] [data-fork-request]`);
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await forkRequests(page)).toEqual([12]);
  });

  test('is not offered when the host does not handle the request', async ({ page }) => {
    await openVersion(page, false);
    await expect(page.locator(`${PANE} [data-version-view]`)).toBeVisible();
    await expect(page.locator(`${PANE} [data-fork-request]`)).toHaveCount(0);
  });
});
