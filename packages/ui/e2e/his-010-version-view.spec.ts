/**
 * Opening an old version from the history pane in the browser (HIS-010 criteria 5, 6 and 7): the
 * view is a region named as a read-only version with its date, leaving returns focus to the control
 * that opened it and removes the view, a refused version shows a message and no view, and the
 * version is released when the user leaves. The state of the version itself (read-only, detached,
 * pinned read) is tested in Node in `packages/engine/src/version-view.test.ts`; the harness draws
 * plain text in the host element, so this run checks the pane's side only.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57580 pnpm exec playwright test -c packages/ui/playwright.config.ts his-010`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

interface Log {
  opened: number[];
  mounted: number;
  unmounted: number;
  closed: number;
}

const readLog = (page: Page): Promise<Log> =>
  page.evaluate(() => (window as unknown as { __versionLog: Log }).__versionLog);

test.describe('an old version in the history pane (HIS-010)', () => {
  test('opens a named version as a region named read-only with its date, and returns focus on leaving', async ({
    page,
  }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    const opener = pane.locator('[data-history="version"] [data-open-version]');
    await opener.focus();
    await page.keyboard.press('Enter');

    const view = pane.locator('[data-version-view]');
    await expect(view).toBeVisible();
    // Criterion 7: the region says it is a read-only version and gives the date.
    const name = await view.getAttribute('aria-label');
    expect(name).toContain('Read-only version');
    expect(name).toContain('2026');
    expect(name).toContain('Board draft');
    await expect(pane.getByRole('region', { name: /Read-only version.*2026/ })).toBeVisible();
    await expect(view.locator('[data-version-body="12"]')).toContainText(
      'The document at version 12.',
    );
    // The list is hidden while the version is read.
    await expect(pane.locator('.de-history-list')).toBeHidden();

    // Criterion 6: leaving puts focus back on the control that opened the version.
    await view.getByRole('button', { name: 'Back to the live document' }).click();
    await expect(pane.locator('[data-version-view]')).toHaveCount(0);
    await expect(opener).toBeFocused();
    const log = await readLog(page);
    expect(log).toMatchObject({ opened: [12], mounted: 1, unmounted: 1, closed: 1 });
  });

  test('opens the state at the end of an editing group, named by its date alone', async ({
    page,
  }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await pane.locator('[data-history="group"] [data-open-version]').first().click();
    const view = pane.locator('[data-version-view]');
    await expect(view.locator('[data-version-body="8"]')).toBeVisible();
    const name = (await view.getAttribute('aria-label')) ?? '';
    expect(name).toMatch(/^Read-only version, .*2026/);
    expect((await readLog(page)).opened).toEqual([8]);
  });

  test('says so, and shows no version, when the service refuses it', async ({ page }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    await page.evaluate(() => {
      (window as unknown as { __versionLog: { outcome: string } }).__versionLog = {
        opened: [],
        mounted: 0,
        unmounted: 0,
        closed: 0,
        outcome: 'forbidden',
      } as never;
    });
    const pane = page.locator(PANE);
    await pane.locator('[data-history="version"] [data-open-version]').click();
    await expect(pane.locator('[data-status="refused"]')).toContainText(
      'You cannot open this version.',
    );
    await expect(pane.locator('[data-version-view]')).toHaveCount(0);
    expect((await readLog(page)).mounted).toBe(0);
  });

  test('offers no way to open a version without the host method', async ({ page }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    await expect(page.locator(PANE).locator('[data-history="version"]')).toBeVisible();
    await expect(page.locator(PANE).locator('[data-open-version]')).toHaveCount(0);
  });
});
