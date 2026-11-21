/**
 * Naming a version in the browser (HIS-006 criterion 6): the command is in the registry and opens a
 * dialog for a name and a note; a name is required; the new version shows in the history list with
 * its name, note, creator and time, markup as text; a service refusal is said in the dialog; and
 * without a port that can name versions the command is not offered. Run from the repository root:
 * `DOCEDIT_UI_PORT=57571 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts his-006-name-version`.
 */
import { axe, expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="history"]';
const DIALOG = '[data-dialog="version"]';

test.describe('naming a version (HIS-006)', () => {
  test('names the document, and the version shows in the open history list', async ({ page }) => {
    const h = await open(page, { history: 'full', features: ['history'], people: 'host' });
    await h.exec('view.history');
    const pane = page.locator(PANE);
    await expect(pane.locator('[data-history="version"]')).toHaveCount(1);

    expect(await h.exec('history.nameVersion')).toMatchObject({ ran: true });
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    // Firefox on Linux (Playwright 1.65; the hosted runner and the Playwright container) crashes its
    // content process ("Page crashed", a segmentation fault in the process) when any of six axe
    // rules that read attributes and sizes runs over the shell with the History pane and this dialog
    // both open (found by running each rule alone: only these six crash, 64 others pass; the crash
    // does not occur without the pane in the tree, and a segmentation fault is the browser's, not a
    // markup error that axe reports). Only there, those six rules are left out of this one call; every
    // other rule runs, and the six run in the other browsers and in the other axe calls.
    const crashes = test.info().project.name === 'firefox' && process.platform === 'linux';
    expect(
      await axe(
        page,
        crashes
          ? {
              disableRules: [
                'aria-allowed-attr',
                'aria-conditional-attr',
                'aria-prohibited-attr',
                'label-content-name-mismatch',
                'nested-interactive',
                'target-size',
              ],
            }
          : {},
      ),
    ).toEqual([]);

    // A name is required: an empty one is refused in the dialog, which stays open.
    await dialog.getByRole('button', { name: 'Name version' }).click();
    await expect(dialog.locator('.de-error')).toContainText('Enter a name.');

    await dialog.getByLabel('Name', { exact: true }).fill('Sent to legal <b>v2</b>');
    await dialog.getByLabel('Note (optional)').fill('Before the <i>call</i>');
    await dialog.getByRole('button', { name: 'Name version' }).click();
    await expect(dialog).toHaveCount(0);

    const versions = pane.locator('[data-history="version"]');
    await expect(versions).toHaveCount(2);
    const named = versions.last();
    await expect(named.locator('[data-content]').first()).toHaveText('Sent to legal <b>v2</b>');
    await expect(named.locator('[data-content]').nth(1)).toHaveText('Before the <i>call</i>');
    await expect(named).toContainText('Named by Ada Lovelace');
    await expect(named).toContainText('2026');
  });

  test('says when the service refuses, and keeps what was typed', async ({ page }) => {
    const h = await open(page, { history: 'refusing', features: ['history'], people: 'host' });
    expect(await h.exec('history.nameVersion')).toMatchObject({ ran: true });
    const dialog = page.locator(DIALOG);
    await dialog.getByLabel('Name', { exact: true }).fill('Draft');
    await dialog.getByRole('button', { name: 'Name version' }).click();
    await expect(dialog.locator('[data-problem="forbidden"]')).toContainText(
      'You cannot name a version of this document.',
    );
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Draft');
  });

  test('is not offered to a reader of named versions, or without the history port', async ({
    page,
  }) => {
    const named = await open(page, { history: 'named', features: ['history'], people: 'host' });
    expect(await named.exec('history.nameVersion')).toMatchObject({ ran: false });
    await page.goto('about:blank');
    const none = await open(page, { features: ['history'], people: 'host' });
    expect(await none.exec('history.nameVersion')).toMatchObject({ ran: false });
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });
});
