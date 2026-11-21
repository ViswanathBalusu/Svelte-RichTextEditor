/**
 * Restoring from the history pane in the browser (HIS-021 criterion 4): an open version offers a
 * restore of what the user may restore; choosing it asks the host for the dry run and shows it with
 * the comparison view (the navigator, the summary by region, the field changes, the marks on the
 * open version); and the real restore is asked for only by the confirmation that the preview shows.
 * Cancelling, a refusal of either step and a preview that changes nothing are covered too.
 *
 * The drawing of the changes in the document is the engine's
 * (`packages/engine/src/view/comparison-view.universal.test.ts`); the harness view records what the
 * pane told it, and the harness port records every dry run and every restore asked for. The service
 * side of the dry run is in `services/document-service/test/control-plane/pro-056-restore-region-dryrun.test.ts`.
 * Run from the repository root:
 * `DOCEDIT_UI_PORT=57621 pnpm exec playwright test -c packages/ui/playwright.config.ts his-021`.
 */
import type { Page } from '@playwright/test';
import { axe, expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';

interface Log {
  opened: number[];
  closed: number;
  drawn?: number;
  drawnChanges?: number[];
  previews?: { toSeq: number; region: string | null }[];
  restores?: { toSeq: number; region: string | null; headSeq: number }[];
}

const readLog = (page: Page): Promise<Log> =>
  page.evaluate(() => (window as unknown as { __versionLog: Log }).__versionLog);

/** Sets what the harness service answers next (HIS-021): a refusal, or a dry run with no change. */
const setOutcome = (
  page: Page,
  patch: { previewOutcome?: string | null; restoreOutcome?: string | null },
): Promise<void> =>
  page.evaluate((p) => {
    const log = (window as unknown as { __versionLog: Record<string, unknown> }).__versionLog;
    for (const [key, value] of Object.entries(p)) {
      if (value === null) Reflect.deleteProperty(log, key);
      else log[key] = value;
    }
  }, patch);

/** Opens the history pane and the named version of the harness (seq 12). */
async function openVersion(page: Page, mode: 'restore' | 'restore-region' | 'versions') {
  const h = await open(page, { history: mode, features: ['history'], people: 'host' });
  await h.exec('view.history');
  const pane = page.locator(PANE);
  await pane.locator('[data-history="version"] [data-open-version]').click();
  const view = pane.locator('[data-version-view]');
  await expect(view).toBeVisible();
  return { pane, view, restore: view.locator('[data-restore]') };
}

test.describe('restoring from the history pane (HIS-021 criterion 4)', () => {
  test('shows the dry run with the comparison view, and restores only after the confirmation', async ({
    page,
  }) => {
    const { pane, view, restore } = await openVersion(page, 'restore');
    await expect(restore.getByRole('heading', { name: 'Restore this version' })).toBeVisible();
    // What this user may restore: the whole document and the region Terms.
    await expect(restore.locator('[data-restore-scope] option')).toHaveText([
      'The whole document',
      'Region: Terms',
    ]);
    // Before a preview there is no way to the real restore, and no comparison.
    await expect(restore.locator('[data-restore-confirm]')).toHaveCount(0);
    await expect(view.locator('[data-compare]')).toHaveCount(0);

    // The first step, by keyboard: the dry run.
    const run = restore.getByRole('button', { name: 'Preview the restore' });
    await run.focus();
    await page.keyboard.press('Enter');

    // The dry run is shown with the comparison view of HIS-013, over the open version.
    const comparison = view.locator('[data-compare]');
    await expect(comparison).toBeVisible();
    const summary = comparison.locator('[data-compare-summary] li');
    await expect(summary).toHaveCount(2);
    await expect(summary.nth(0)).toContainText('Terms: 2 changes');
    await expect(summary.nth(1)).toContainText('Outside regions: 1 change');
    await expect(comparison.locator('[data-compare-fields] li')).toHaveText(
      'Name was changed by Grace Hopper',
    );
    // In words, and in a polite live region: what would happen, and that nothing has happened.
    const status = restore.locator('[data-restore-status]');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveText(
      'Restoring would make 3 changes. Nothing has been changed yet.',
    );
    await expect(restore.locator('[data-restore-target]')).toHaveText(
      'To be restored: The whole document',
    );
    // The control that had focus was replaced by the confirmation; the heading above it has focus,
    // and from there the keyboard reaches the confirmation and then the way out, in that order.
    await expect(restore.getByRole('heading', { name: 'Restore this version' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(restore.getByRole('button', { name: 'Restore now' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(restore.getByRole('button', { name: 'Cancel the restore' })).toBeFocused();

    let log = await readLog(page);
    expect(log.previews).toEqual([{ toSeq: 12, region: null }]);
    // Only the dry run was asked for: nothing is restored, and the same version is still open.
    expect(log.restores ?? []).toEqual([]);
    expect(log.opened).toEqual([12]);
    expect(log.drawnChanges).toEqual([3]);

    // The changes are navigated as in any comparison.
    await comparison.getByRole('button', { name: 'Next change' }).click();
    await expect(comparison.locator('[data-compare-announce]')).toHaveText(
      'Change 1 of 3: text changed, by Ada Lovelace',
    );

    // The open version with the preview and its confirmation has no axe violation.
    expect(await axe(page)).toEqual([]);

    // The second step: the confirmation, by keyboard. Only now is the restore asked for.
    const confirm = restore.getByRole('button', { name: 'Restore now' });
    await expect(restore.getByRole('button', { name: 'Cancel the restore' })).toBeVisible();
    await confirm.focus();
    await page.keyboard.press('Enter');

    await expect(pane.locator('[data-version-view]')).toHaveCount(0);
    log = await readLog(page);
    // The request of the preview, with the head it was computed against.
    expect(log.restores).toEqual([{ toSeq: 12, region: null, headSeq: 30 }]);
    expect(log.previews).toHaveLength(1);
    expect(log.closed).toBe(1);
    // The pane says so, in words that stay, and the shell's live region said it once.
    await expect(pane.locator('[data-status="restored"]')).toHaveText(
      'The document was restored. The state before the restore is kept in the history.',
    );
    await expect(
      page.locator('[role="status"]', { hasText: 'The document was restored.' }).first(),
    ).toBeAttached();
    // The list was read again and holds the restore; the heading of the history has focus (the
    // pane's frame has a title of its own with the same words).
    await expect(pane.locator('[data-history="group"]').first()).toContainText('Origins: restore');
    await expect(pane.locator('.de-history > h2.de-subhead')).toBeFocused();
  });

  test('a preview can be cancelled: nothing is restored, the marks go, the version stays', async ({
    page,
  }) => {
    const { view, restore } = await openVersion(page, 'restore');
    await restore.getByRole('button', { name: 'Preview the restore' }).click();
    await expect(view.locator('[data-compare]')).toBeVisible();

    const cancel = restore.getByRole('button', { name: 'Cancel the restore' });
    await cancel.focus();
    await page.keyboard.press('Enter');

    await expect(restore.locator('[data-restore-confirm]')).toHaveCount(0);
    await expect(view.locator('[data-compare]')).toHaveCount(0);
    await expect(restore.locator('[data-restore-status]')).toHaveText('');
    // The version the user was reading is still open, and focus is back on the first step.
    await expect(view).toBeVisible();
    await expect(restore.getByRole('button', { name: 'Preview the restore' })).toBeFocused();
    const log = await readLog(page);
    expect(log.restores ?? []).toEqual([]);
    expect(log.closed).toBe(0);
    // The view was told to draw the three changes, then to remove them.
    expect(log.drawnChanges).toEqual([3, 0]);
  });

  test('restores one region when that is all the user may restore', async ({ page }) => {
    const { pane, restore } = await openVersion(page, 'restore-region');
    // No whole-document restore is offered to a user without `manage`.
    await expect(restore.locator('[data-restore-scope] option')).toHaveText(['Region: Terms']);
    await restore.getByRole('button', { name: 'Preview the restore' }).click();
    await expect(restore.locator('[data-restore-status]')).toHaveText(
      'Restoring would make 2 changes. Nothing has been changed yet.',
    );
    await expect(restore.locator('[data-restore-target]')).toHaveText(
      'To be restored: Region: Terms',
    );
    // What the restore would bring back besides the text (HIS-020) is said before the confirmation.
    await expect(restore.locator('[data-restore-note="recreated"]')).toHaveText(
      'These definitions would be brought back: LegalQuote.',
    );
    expect((await readLog(page)).previews).toEqual([{ toSeq: 12, region: 'r1' }]);

    await restore.getByRole('button', { name: 'Restore now' }).click();
    await expect(pane.locator('[data-version-view]')).toHaveCount(0);
    expect((await readLog(page)).restores).toEqual([{ toSeq: 12, region: 'r1', headSeq: 30 }]);
  });

  test('says in words why the service refuses the dry run or the restore', async ({ page }) => {
    const { pane, view, restore } = await openVersion(page, 'restore');
    const run = restore.getByRole('button', { name: 'Preview the restore' });
    const refused = restore.locator('[data-status="restore-refused"]');

    // The dry run needs the same permission as the restore: a refusal shows no comparison.
    await setOutcome(page, { previewOutcome: 'forbidden' });
    await run.click();
    await expect(refused).toHaveText('You cannot restore this.');
    await expect(refused).toHaveAttribute('role', 'alert');
    await expect(refused).toHaveAttribute('data-step', 'preview');
    await expect(view.locator('[data-compare]')).toHaveCount(0);
    await expect(restore.locator('[data-restore-confirm]')).toHaveCount(0);

    await setOutcome(page, { previewOutcome: 'workflow_active' });
    await run.click();
    await expect(refused).toHaveText('A workflow is active, so the document cannot be restored.');

    // A restore refused after its preview: the preview is withdrawn and a new one is asked for.
    await setOutcome(page, { previewOutcome: null, restoreOutcome: 'conflict' });
    await run.click();
    await expect(view.locator('[data-compare]')).toBeVisible();
    await restore.getByRole('button', { name: 'Restore now' }).click();
    await expect(refused).toContainText('Preview the restore again.');
    await expect(refused).toHaveAttribute('data-step', 'restore');
    await expect(view.locator('[data-compare]')).toHaveCount(0);
    await expect(restore.locator('[data-restore-confirm]')).toHaveCount(0);
    await expect(run).toBeFocused();
    // Nothing was restored: the version is still open and the list has no restore.
    await expect(view).toBeVisible();
    await expect(pane.locator('[data-status="restored"]')).toHaveCount(0);
    const log = await readLog(page);
    expect(log.restores).toHaveLength(1);
    expect(log.closed).toBe(0);
  });

  test('does not let a preview that changes nothing be confirmed', async ({ page }) => {
    const { view, restore } = await openVersion(page, 'restore');
    await setOutcome(page, { previewOutcome: 'unchanged' });
    await restore.getByRole('button', { name: 'Preview the restore' }).click();
    await expect(restore.locator('[data-restore-status]')).toHaveText(
      'Restoring would change nothing: the document already matches this version.',
    );
    await expect(view.locator('[data-compare] [data-status="no-differences"]')).toBeVisible();
    const confirm = restore.locator('[data-restore-confirm]');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    // Pressing it all the same asks for nothing.
    await confirm.click({ force: true });
    await confirm.focus();
    await page.keyboard.press('Enter');
    await expect(view).toBeVisible();
    expect((await readLog(page)).restores ?? []).toEqual([]);
  });

  test('is not offered when the host gives no restore', async ({ page }) => {
    const { view, restore } = await openVersion(page, 'versions');
    await expect(view).toBeVisible();
    await expect(restore).toHaveCount(0);
  });

  test('is not offered on the current document that a comparison opens', async ({ page }) => {
    const h = await open(page, { history: 'restore', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    // An older state against the current document: the view that opens is the document as it is now.
    await pane.locator('[data-compare-run]').click();
    const view = pane.locator('[data-version-view]');
    await expect(view.locator('[data-compare]')).toBeVisible();
    await expect(view.locator('[data-restore]')).toHaveCount(0);
  });

  test('leaving the version drops the preview, and the next version starts without one', async ({
    page,
  }) => {
    const { pane, view, restore } = await openVersion(page, 'restore');
    await restore.getByRole('button', { name: 'Preview the restore' }).click();
    await expect(restore.locator('[data-restore-confirm]')).toBeVisible();
    await view.getByRole('button', { name: 'Back to the live document' }).click();
    await expect(pane.locator('[data-version-view]')).toHaveCount(0);

    // Another state of the list (the end of an editing group, seq 8): no confirmation is waiting.
    await pane.locator('[data-history="group"] [data-open-version]').first().click();
    await expect(view).toBeVisible();
    await expect(restore.locator('[data-restore-confirm]')).toHaveCount(0);
    await expect(restore.getByRole('button', { name: 'Preview the restore' })).toBeVisible();
    await expect(view.locator('[data-compare]')).toHaveCount(0);
    expect((await readLog(page)).restores ?? []).toEqual([]);
  });
});
