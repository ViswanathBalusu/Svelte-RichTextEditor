/**
 * "Who wrote this" in the history pane, in the browser (HIS-015 criteria 1, 3 and 6): the user asks
 * about the open version for the whole document, a region or the selected passage; the answer is the
 * host's, for that version; it lists the authors and the times in words, shows an erased person as
 * an unknown person, says who brought text back, and uses no colour for any of it. Refusals and an
 * empty answer have messages.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57584 pnpm exec playwright test -c packages/ui/playwright.config.ts his-015`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

interface Log {
  opened: number[];
  asked?: { seq: number; region: string | null; blocks: string[] | null }[];
  selected?: string[];
  whoOutcome?: string;
}

const readLog = (page: Page): Promise<Log> =>
  page.evaluate(() => (window as unknown as { __versionLog: Log }).__versionLog);

const setLog = (page: Page, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((p) => {
    const w = window as unknown as { __versionLog: Record<string, unknown> };
    // Changed in place: the harness view holds the log it was opened with.
    Object.assign((w.__versionLog ??= { opened: [], mounted: 0, unmounted: 0, closed: 0 }), p);
  }, patch);

async function openNamedVersion(page: Page): Promise<void> {
  const h = await open(page, { history: 'versions', features: ['history'], people: 'host' });
  await h.exec('view.history');
  await page.locator(`${PANE} [data-history="version"] [data-open-version]`).click();
  await expect(page.locator(`${PANE} [data-version-view]`)).toBeVisible();
}

test.describe('who wrote this, in the history pane (HIS-015)', () => {
  test('answers for the version that is open, in words, with the times and the people', async ({
    page,
  }) => {
    await openNamedVersion(page);
    const view = page.locator(`${PANE} [data-version-view]`);
    await view.locator('[data-who-ask]').click();
    const answer = view.locator('[data-who-answer] li');
    await expect(answer).toHaveCount(3);
    // The question is about the open version (seq 12) and the whole body.
    expect((await readLog(page)).asked).toEqual([{ seq: 12, region: null, blocks: null }]);
    // Earliest author first; each line names the person, the number of passages and the times.
    await expect(answer.nth(0)).toContainText('Brought back by Ada Lovelace.');
    await expect(answer.nth(0)).toContainText('Grace Hopper: 1 passage');
    await expect(answer.nth(1)).toContainText('Ada Lovelace: 2 passages');
    await expect(answer.nth(1)).toContainText('2026');
    // An erased person is an unknown person (HIS-038).
    await expect(answer.nth(2)).toContainText('Unknown person: 1 passage');
    // The status region is polite and the list has a name: a screen reader hears who and when.
    await expect(view.locator('[data-who-status]')).toHaveAttribute('aria-live', 'polite');
    await expect(view.getByRole('list', { name: 'Who wrote this' })).toBeVisible();
  });

  test('carries no meaning by colour: the answer has no colour-coded element', async ({ page }) => {
    await openNamedVersion(page);
    const view = page.locator(`${PANE} [data-version-view]`);
    await view.locator('[data-who-ask]').click();
    const lines = view.locator('[data-who-answer] li');
    await expect(lines).toHaveCount(3);
    // Every line has the same colour as the list: nothing is told apart by colour.
    const colours = await lines.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    expect(new Set(colours).size).toBe(1);
    const text = await lines.allTextContents();
    expect(text.every((t) => /\d+ passages?/.test(t))).toBe(true);
  });

  test('asks for a region, and for the selected passage when the version reports one', async ({
    page,
  }) => {
    await openNamedVersion(page);
    const view = page.locator(`${PANE} [data-version-view]`);
    await view.locator('[data-who-scope]').selectOption({ label: 'Region: Terms' });
    await view.locator('[data-who-ask]').click();
    await expect(view.locator('[data-who-answer] li').first()).toBeVisible();

    // Nothing selected: the pane says so and does not ask the host.
    await view.locator('[data-who-scope]').selectOption({ label: 'The selected passage' });
    await view.locator('[data-who-ask]').click();
    await expect(view.locator('[data-who-status]')).toContainText(
      'Select a passage in the version first.',
    );
    await setLog(page, { selected: ['pA', 'pB'] });
    await view.locator('[data-who-ask]').click();
    await expect(view.locator('[data-who-answer] li').first()).toBeVisible();
    expect((await readLog(page)).asked).toEqual([
      { seq: 12, region: 'r1', blocks: null },
      { seq: 12, region: null, blocks: ['pA', 'pB'] },
    ]);
  });

  test('says so when the answer is empty or refused, and clears it when the version is left', async ({
    page,
  }) => {
    await openNamedVersion(page);
    const view = page.locator(`${PANE} [data-version-view]`);
    await setLog(page, { whoOutcome: 'empty' });
    await view.locator('[data-who-ask]').click();
    await expect(view.locator('[data-who-status]')).toContainText(
      'No text is recorded for this passage.',
    );
    await setLog(page, { whoOutcome: 'forbidden' });
    await view.locator('[data-who-ask]').click();
    await expect(view.locator('[data-who-status]')).toContainText(
      'You cannot see who wrote this version.',
    );
    await setLog(page, { whoOutcome: 'failed' });
    await view.locator('[data-who-ask]').click();
    await expect(view.locator('[data-who-status]')).toContainText(
      'Who wrote this could not be found.',
    );
    await view.getByRole('button', { name: 'Back to the live document' }).click();
    await page.locator(`${PANE} [data-history="version"] [data-open-version]`).click();
    await expect(page.locator(`${PANE} [data-version-view] [data-who-status]`)).toHaveText('');
  });

  test('answers for the other version when another one is opened', async ({ page }) => {
    await openNamedVersion(page);
    const view = page.locator(`${PANE} [data-version-view]`);
    await view.getByRole('button', { name: 'Back to the live document' }).click();
    await page.locator(`${PANE} [data-history="group"] [data-open-version]`).first().click();
    await page.locator(`${PANE} [data-version-view] [data-who-ask]`).click();
    await expect(page.locator(`${PANE} [data-who-answer] li`).first()).toBeVisible();
    const asked = (await readLog(page)).asked;
    expect(asked?.at(-1)?.seq).toBe(8);
  });
});
