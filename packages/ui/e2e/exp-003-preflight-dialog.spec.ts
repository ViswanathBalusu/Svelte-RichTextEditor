/**
 * EXP-003 criterion 3, the dialog half (lane w2): when the core's preflight has warnings, the
 * export dialog lists them before any job is created, and the author continues or stops. The core
 * here is the harness's fake (`test/support/fake-core.ts`), whose `preflight` answers what the
 * test sets; the real editor does not run the shared preflight yet (see the story Notes). Run with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/exp-003-preflight-dialog.spec.ts`.
 */
import { axe, expect, open, test } from './helpers.ts';

const WARNINGS = [
  {
    severity: 'warning',
    code: 'image_without_alt',
    blockId: 'p7',
    message: 'an image has no alternative text (09 §13)',
  },
  {
    severity: 'warning',
    code: 'table_cannot_span_pages',
    blockId: 'p8',
    message: 'a table in a multi-column section cannot span pages',
  },
];

test.describe('preflight warnings in the export dialog (EXP-003)', () => {
  test('lists the warnings before a job is created; Continue creates it', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.setExportPreflight(WARNINGS);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();

    const list = dialog.getByRole('list', { name: 'Check before you export' });
    await expect(list.getByRole('button')).toHaveText([
      /Warning\s*an image has no alternative text/,
      /Warning\s*a table in a multi-column section cannot span pages/,
    ]);
    await expect(dialog).toContainText('Nothing has been exported yet');
    // No job yet, and the form cannot start a second request while the warnings are open.
    expect(await h.exportRequests()).toEqual([]);
    expect(await h.exportPreflights()).toEqual(['pdf']);
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
    expect(await axe(page)).toEqual([]);

    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(list).toHaveCount(0);
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Waiting to start');
    expect((await h.exportRequests()).map((r: { target: string }) => r.target)).toEqual(['pdf']);
  });

  test('Do not export creates no job and leaves the dialog ready', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.setExportPreflight(WARNINGS);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await dialog.getByRole('button', { name: 'Do not export' }).click();
    await expect(dialog.getByRole('list', { name: 'Check before you export' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
    expect(await h.exportRequests()).toEqual([]);
  });

  test('choosing a warning moves the editor to its block and creates no job', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.setExportPreflight(WARNINGS);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await dialog
      .getByRole('list', { name: 'Check before you export' })
      .getByRole('button')
      .first()
      .click();
    await expect(dialog).toHaveCount(0);
    expect(await h.callsOf('selectBlock')).toEqual([['p7']]);
    expect(await h.exportRequests()).toEqual([]);
  });

  test('control: a preflight without warnings creates the job at once', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.locator('[data-status="export"]')).toBeVisible();
    expect(await h.exportPreflights()).toEqual(['pdf']);
    expect((await h.exportRequests()).length).toBe(1);
  });
});
