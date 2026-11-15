/**
 * One registered entry is read by every command surface (UX-003, criterion 1, lane w3). The earlier
 * spec (ux-003-registry-surfaces.spec.ts) left out the compact toolbar and the mini toolbar, because
 * its entry was in the `ext` group. Here one entry is registered at run time in the `format` group
 * with `changesContent`, a context-menu target and an access key, so it qualifies for every surface
 * by the surfaces' own rules (UX-006: the compact row shows every offered toolbar command; UX-010:
 * the mini toolbar shows the `format` commands that change content). The same entry is then found
 * in the compact toolbar, the mini toolbar, the context menu, command search, the access-key mode
 * and the full toolbar, and `exec` runs it. The second test covers extensions: a command that a
 * host extension registers through the extension API lands in the same registry, so the toolbar,
 * command search and `exec` read it, and it leaves them when the extension is removed.
 *
 * Run with `DOCEDIT_UI_PORT=<free port> pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ux-003-w3-all-surfaces.spec.ts`.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

const PROBE = 'ext.everySurface';
const FROM_EXTENSION = 'ext.notes.insert';

async function tapAlt(page: Page): Promise<void> {
  await page.keyboard.down('Alt');
  await page.keyboard.up('Alt');
}

test.describe('one registry entry, every surface (UX-003, criterion 1, lane w3)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('the compact toolbar, the mini toolbar, the context menu, command search, access keys, exec and the full toolbar read the same entry', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const probe = `[data-command-id="${PROBE}"]`;
    // Before registration no surface has it.
    await expect(page.locator(probe)).toHaveCount(0);
    const error = await h.tryRegister({
      id: PROBE,
      label: 'command.format.bold',
      group: 'format',
      accessKey: 'k',
      changesContent: true,
      enabled: 'canEditSelection',
      contextMenu: ['text'],
    });
    expect(error).toBeNull();
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    await h.frames(2);

    // Compact toolbar: the entry is a button of the one-row toolbar.
    const compact = page.getByRole('toolbar', { name: 'Editing' });
    await expect(compact.locator(probe)).toBeVisible();

    // Mini toolbar: near the selection, with the built-in formatting commands.
    const mini = page.locator('[data-mini-toolbar]');
    await expect(mini.locator('[data-command-id="format.bold"]')).toBeVisible();
    await expect(mini.locator(probe)).toBeVisible();

    // Context menu.
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    await expect(page.getByRole('menu').locator(probe)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Command search.
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('bold');
    await expect(page.getByRole('listbox').locator(probe)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Command name' })).toHaveCount(0);

    // Access keys.
    await focusSurface(page);
    await tapAlt(page);
    await expect(page.locator('[data-access-tip="K"]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // exec runs the entry; so does its button in the compact toolbar.
    expect(await h.exec(PROBE)).toEqual({ ran: true, reason: null });
    await compact.locator(probe).click();
    expect((await h.commandRuns()).filter((id) => id === PROBE)).toHaveLength(2);

    // Full toolbar: the same entry, in the group it names, after the setting changes.
    await h.setSettings({ toolbar: 'full' });
    await page.locator('[role="tab"][data-group="format"]').click();
    await expect(page.locator(`[role="tabpanel"] ${probe}`)).toBeVisible();

    // One registry: removing the entry removes it from every surface.
    await h.unregister(PROBE);
    await expect(page.locator(probe)).toHaveCount(0);
    expect((await h.exec(PROBE)).ran).toBe(false);
  });

  test('a command registered by an extension is in the same registry as the built-in ones', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const fromExtension = `[data-command-id="${FROM_EXTENSION}"]`;
    const compact = page.getByRole('toolbar', { name: 'Editing' });
    await expect(compact.locator(fromExtension)).toHaveCount(0);

    await h.setExtensions('valid');
    expect(await h.commandIds()).toContain(FROM_EXTENSION);
    expect(await h.commandIds()).toContain('format.bold');
    // The `ext` group is last in the row, so at this width its control is in the overflow: the
    // toolbar holds it, and the "More" menu of the same toolbar shows it.
    await expect(compact.locator(fromExtension)).toHaveCount(1);
    await page.locator('[data-command-id="toolbar.more"]').click();
    await expect(page.getByRole('menu').locator(fromExtension)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('bold');
    await expect(page.getByRole('listbox').locator(fromExtension)).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await h.exec(FROM_EXTENSION)).toEqual({ ran: true, reason: null });

    await h.setExtensions('none');
    await expect(compact.locator(fromExtension)).toHaveCount(0);
    expect(await h.commandIds()).not.toContain(FROM_EXTENSION);
  });
});
