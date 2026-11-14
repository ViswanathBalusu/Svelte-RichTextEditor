/**
 * One registered entry is read by every command surface (UX-003, criterion 1, lane V-UX-001-015).
 * A command registered at run time, with a key, an access key and a context-menu target, appears
 * in the full toolbar, the context menu, command search and the access-key mode, and `exec` runs
 * the same entry. The compact toolbar and the mini toolbar are not checked here: the compact row
 * takes the phase 1a commands only (UX-006), and the mini toolbar takes the `format` group only
 * (UX-010). Run with `DOCEDIT_UI_PORT=57250 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-003-registry-surfaces.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

const PROBE = 'ext.registrySurfaces';

async function tapAlt(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.up('Alt');
}

test.describe('one registry entry, every surface (UX-003, criterion 1)', () => {
  test('the full toolbar, the context menu, command search, access keys and exec read the same entry', async ({
    page,
  }) => {
    const h = await open(page, { toolbar: 'full', extended: true });
    const error = await h.tryRegister({
      id: PROBE,
      label: 'command.format.bold',
      group: 'ext',
      accessKey: 'k',
      changesContent: true,
      enabled: 'canEditSelection',
      contextMenu: ['text'],
    });
    expect(error).toBeNull();
    await focusSurface(page);
    await h.setSelection({ empty: false });
    await h.frames(2);

    // Full toolbar: the entry is in the toolbar.
    await page.locator('[role="tab"][data-group="ext"]').click();
    await expect(page.locator(`[role="tabpanel"] [data-command-id="${PROBE}"]`)).toBeVisible();

    // Context menu: the entry is listed for the text.
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    await expect(page.getByRole('menu').locator(`[data-command-id="${PROBE}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Command search: the entry is found by its label and listed with the built-in ones.
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('bold');
    await expect(page.getByRole('listbox').locator(`[data-command-id="${PROBE}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Command name' })).toHaveCount(0);

    // Access keys: Alt shows the key K of the entry.
    await focusSurface(page);
    await tapAlt(page);
    await expect(page.locator('[data-access-tip="K"]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // exec runs the same entry, and the registry records the run.
    expect(await h.exec(PROBE)).toEqual({ ran: true, reason: null });
    expect(await h.commandRuns()).toContain(PROBE);
  });
});
