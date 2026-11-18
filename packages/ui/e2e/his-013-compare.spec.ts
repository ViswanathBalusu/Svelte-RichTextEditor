/**
 * Comparing two versions from the history pane in the browser (HIS-013 criteria 2, 3, 5 and 6): the
 * pickers offer only what the list shows, a comparison opens the newer version and hands it the
 * changes, next and previous move by keyboard and a live region says "n of m", the kind and the
 * author, the summary is grouped by region, a field change names the field and who changed it, and a
 * refusal shows a message. The drawing of the changes in the document is the engine's
 * (`packages/engine/src/view/comparison-view.universal.test.ts`); the harness view only records
 * what the pane told it.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57582 pnpm exec playwright test -c packages/ui/playwright.config.ts his-013`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

interface Log {
  opened: number[];
  compared?: [number, number | null][];
  drawn?: number;
  deletions?: boolean[];
  focused?: number[];
  closed: number;
  compareOutcome?: string;
}

const readLog = (page: Page): Promise<Log> =>
  page.evaluate(() => (window as unknown as { __versionLog: Log }).__versionLog);

test.describe('comparing versions in the history pane (HIS-013)', () => {
  test('compares an older state with the current document and draws the changes on the newer one', async ({
    page,
  }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await pane.locator('[data-compare-run]').click();

    const view = pane.locator('[data-version-view]');
    await expect(view.locator('[data-compare]')).toBeVisible();
    const log = await readLog(page);
    expect(log.compared).toEqual([[8, null]]);
    // The newer version is the current document, opened read-only, and was handed the changes.
    expect(log.opened).toEqual([30]);
    expect(log.drawn).toBe(1);
    // Criterion 3: the summary lists the changes grouped by region.
    const summary = view.locator('[data-compare-summary] li');
    await expect(summary).toHaveCount(2);
    await expect(summary.nth(0)).toContainText('Terms: 2 changes');
    await expect(summary.nth(1)).toContainText('Outside regions: 2 changes');
    // Criterion 5: a field change names the field and who changed it.
    await expect(view.locator('[data-compare-fields] li')).toHaveText(
      'Name was changed by Grace Hopper',
    );
  });

  test('moves between changes with the keyboard and announces the position, the kind and the author', async ({
    page,
    browserName,
  }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await pane.locator('[data-compare-run]').click();
    const view = pane.locator('[data-version-view]');
    const announce = view.locator('[data-compare-announce]');
    await expect(announce).toHaveAttribute('aria-live', 'polite');

    const next = view.getByRole('button', { name: 'Next change' });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(announce).toHaveText('Change 1 of 4: text changed, by Ada Lovelace');
    await page.keyboard.press('Enter');
    await expect(announce).toHaveText('Change 2 of 4: field value changed, by Grace Hopper');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(announce).toHaveText('Change 4 of 4: removed, by Grace Hopper');
    // Wraps to the first, and Previous goes back to the last.
    await page.keyboard.press('Enter');
    await expect(announce).toContainText('Change 1 of 4');
    await view.getByRole('button', { name: 'Previous change' }).click();
    await expect(announce).toContainText('Change 4 of 4');
    // F3 and Shift+F3 move on from anywhere in the view, also when focus has gone into the document.
    // WebKit never delivers Shift+F3 to the page under Playwright (its own find-previous takes it), so the
    // shortcuts are checked on Chromium and Firefox only; the buttons are checked on all three.
    const keys = browserName !== 'webkit';
    if (keys) {
      await page.keyboard.press('Shift+F3');
      await expect(announce).toContainText('Change 3 of 4');
      await page.keyboard.press('F3');
      await expect(announce).toContainText('Change 4 of 4');
    }
    expect((await readLog(page)).focused).toEqual(
      keys ? [0, 1, 2, 3, 0, 3, 2, 3] : [0, 1, 2, 3, 0, 3],
    );

    // Deleted text is shown on demand.
    await view.getByLabel('Show deleted text').check();
    await view.getByLabel('Show deleted text').uncheck();
    expect((await readLog(page)).deletions).toEqual([false, true, false]);
  });

  test('shows a message when the service refuses the comparison, and no version', async ({
    page,
  }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    await page.evaluate(() => {
      (window as unknown as { __versionLog: Record<string, unknown> }).__versionLog = {
        opened: [],
        mounted: 0,
        unmounted: 0,
        closed: 0,
        compareOutcome: 'forbidden',
      };
    });
    const pane = page.locator(PANE);
    await pane.locator('[data-compare-run]').click();
    await expect(pane.locator('[data-status="compare-refused"]')).toContainText(
      'You cannot compare these versions.',
    );
    await expect(pane.locator('[data-version-view]')).toHaveCount(0);
  });

  test('offers only the versions the list shows to a reader of named versions (criterion 6)', async ({
    page,
  }) => {
    const h = await open(page, { history: 'named', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    const from = pane.locator('[data-compare-from] option');
    await expect(from).toHaveCount(1);
    await expect(from.first()).toContainText('Board draft');
    // The newer end is the current document or that one version: no editing group is offered.
    await expect(pane.locator('[data-compare-to] option')).toHaveCount(2);
    await expect(pane.locator('[data-compare-to]')).not.toContainText('Changes up to');
  });

  test('closing the comparison returns focus to the Compare button and releases the version', async ({
    page,
  }) => {
    const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    const run = pane.locator('[data-compare-run]');
    await run.focus();
    await page.keyboard.press('Enter');
    const view = pane.locator('[data-version-view]');
    await expect(view).toBeVisible();
    await view.getByRole('button', { name: 'Back to the live document' }).click();
    await expect(pane.locator('[data-version-view]')).toHaveCount(0);
    await expect(run).toBeFocused();
    expect((await readLog(page)).closed).toBe(1);
  });
});
