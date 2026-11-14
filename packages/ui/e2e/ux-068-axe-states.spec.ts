/**
 * axe on the shell's remaining states (UX-068, criterion 1, lane V-UX-061-075). The earlier
 * a11y.spec.ts and shell-wcag.spec.ts covered the default shell, the header with presence, the
 * overflow menu, one pane, the export dialog and the save states. This file adds each tab of the
 * full toolbar, the context menu for a selection, the export dialog with the status bar, the
 * command search with its results listed, and the outline pane. The other panes and dialogs are
 * checked in ux-068-axe-panes-dialogs.spec.ts.
 * Run from the repository root, one browser at a time:
 * `DOCEDIT_UI_PORT=57291 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts ux-068-axe-states`.
 */
import { axe, expect, open, test } from './helpers.ts';

test.describe('axe finds no violation in the remaining shell states (UX-068, criterion 1)', () => {
  test('on every tab of the full toolbar', async ({ page }) => {
    // One axe run per tab: longer than the 30 s default in the slower browsers.
    test.setTimeout(180_000);
    await open(page, { extended: true, toolbar: 'full', features: ['presence'], presence: [] });
    const tabs = page.locator('#host').locator('[role="tab"]');
    const count = await tabs.count();
    // Zero tabs would pass vacuously.
    expect(count).toBeGreaterThan(1);
    const failures: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const label = (await tabs.nth(i).textContent())?.trim() ?? `tab ${i}`;
      await tabs.nth(i).click();
      await page.waitForTimeout(50);
      for (const v of await axe(page)) failures.push(`${label}: ${v}`);
    }
    expect(failures).toEqual([]);
  });

  test('with the context menu for a selection open', async ({ page }) => {
    await open(page, { extended: true });
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    await expect(page.getByRole('menu', { name: 'Commands for the selection' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with the export dialog open and the status bar shown', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.exec('document.export');
    await expect(page.locator('#host').locator('[part="dialog"]').first()).toBeVisible();
    await expect(page.locator('.de-status').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('menu items and export dialog controls are at least 24 by 24 CSS pixels (criterion 2, extended)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    await expect(page.getByRole('menu', { name: 'Commands for the selection' })).toBeVisible();
    const menuSmall = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const items = root.querySelectorAll<HTMLElement>('[role="menuitem"], [data-menu-item]');
      const small: string[] = [];
      for (const el of items) {
        const b = el.getBoundingClientRect();
        if (b.width < 24 || b.height < 24)
          small.push(`${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return { measured: items.length, small };
    });
    expect(menuSmall.measured).toBeGreaterThan(1);
    expect(menuSmall.small).toEqual([]);
    await page.keyboard.press('Escape');
    await h.exec('document.export');
    await expect(page.locator('#host').locator('[part="dialog"]').first()).toBeVisible();
    const dialogSmall = await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const dialog = root.querySelector('[part="dialog"]')!;
      const controls = dialog.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), select',
      );
      const small: string[] = [];
      let measured = 0;
      for (const el of controls) {
        if (el.getClientRects().length === 0) continue;
        measured += 1;
        // A radio or checkbox inside its `.de-check` label is measured by the label, the element
        // that takes the pointer (its text is part of the control). The bare 15 px input is
        // reported in the story Notes, not claimed here.
        const target = el.closest<HTMLElement>('label.de-check') ?? el;
        const b = target.getBoundingClientRect();
        if (b.width < 24 || b.height < 24)
          small.push(`${el.tagName}: ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return { measured, small };
    });
    expect(dialogSmall.measured).toBeGreaterThan(0);
    expect(dialogSmall.small).toEqual([]);
  });

  test('with the command search open and results listed', async ({ page }) => {
    await open(page, { extended: true });
    await page.locator('.de-editing-surface').focus();
    await page.keyboard.press('Alt+q');
    await expect(page.getByRole('combobox', { name: 'Command name' })).toBeFocused();
    await page.keyboard.type('bold');
    await expect(page.getByRole('listbox').locator('[role="option"]').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('with the outline pane open', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    await page.locator('.de-outline').waitFor();
    expect(await axe(page)).toEqual([]);
  });
});
