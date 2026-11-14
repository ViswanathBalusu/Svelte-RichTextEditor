/**
 * Output restrictions in the export dialog (UX-040 criterion 1, the dialog half; lane
 * U-UX-031-045). Under `no-export` the deployment's export targets are shown disabled with the
 * reason, the Start button is disabled, and no export request is sent. Without the restriction the
 * same dialog is enabled (the control). Run with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-040-export-restrictions.spec.ts`.
 */
import { axe, expect, focusSurface, open, test } from './helpers.ts';

const LIMITED = {
  rev: 2,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit'],
  scopes: { body: ['view', 'comment', 'suggest', 'edit'] },
  restrictions: ['no-export'],
};

const UNRESTRICTED = { ...LIMITED, rev: 1, restrictions: [] };

test.describe('output restrictions in the export dialog (UX-040)', () => {
  test('under no-export the targets are disabled with the reason, Export is disabled and no request is sent', async ({
    page,
  }) => {
    // The command is refused before the dialog opens under `no-export` (ux-040-export-command-state);
    // the dialog is opened without the restriction, and the restriction then arrives while it is open.
    const h = await open(page, {
      extended: true,
      features: ['exports'],
      permissions: UNRESTRICTED,
    });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();
    await h.setPermissions(LIMITED);
    const format = dialog.getByRole('group', { name: 'Format' });
    const pdf = format.getByRole('radio', { name: 'PDF' });
    await expect(pdf).toBeDisabled();
    await expect(pdf).toHaveAccessibleDescription('Your access does not allow export.');
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
    expect(await h.exportRequests()).toEqual([]);
    expect(await axe(page)).toEqual([]);
  });

  test('control: without the restriction the target is enabled and Export is enabled', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();
    const format = dialog.getByRole('group', { name: 'Format' });
    await expect(format.getByRole('radio', { name: 'PDF' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  });
});
