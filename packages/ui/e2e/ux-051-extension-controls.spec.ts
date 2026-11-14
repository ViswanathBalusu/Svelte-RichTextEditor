/**
 * Contributed controls (UX-051, criterion 5, lane V-UX-046-060): an extension command shows in the
 * compact toolbar and in the context menu, both are operable from the keyboard, and each carries
 * an accessible name taken from the extension's own string. Run from the repository root with
 * `DOCEDIT_UI_PORT=57280 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-051-extension-controls.spec.ts`.
 */
import { expect, focused, open, test } from './helpers.ts';

const COMMAND = 'ext.insert-note';
const NAME = 'Insert note from the extension';

test.describe('extension controls are operable and named (UX-051)', () => {
  test('a contributed toolbar button is reached by keyboard, named by the extension string and runs', async ({
    page,
  }) => {
    // The full layout shows every group; the compact row moves a command that does not fit into "More".
    const h = await open(page, { toolbar: 'full', extended: true, overrides: { [COMMAND]: NAME } });
    const error = await h.tryRegister({ id: COMMAND, label: COMMAND, group: 'ext' });
    expect(error).toBeNull();
    await h.frames(2);
    // The full layout shows one group per tab; the extension's group is the "ext" tab.
    const tab = page.locator('.de-shell .de-tab[data-group="ext"]');
    await expect(tab).toHaveCount(1);
    const button = page.locator(`.de-shell .de-tabpanel [data-command-id="${COMMAND}"]`);
    // Keyboard: the tab is chosen with Enter, then Tab moves into its panel to the contributed button.
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName(NAME);
    await page.locator('.de-shell .de-tab[aria-selected="true"]').focus();
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await focused(page)).command === COMMAND;
    }
    expect(reached).toBe(true);
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await h.frames(2);
    expect(await h.commandRuns()).toContain(COMMAND);
  });

  test('a contributed context-menu item is named, reached by arrow keys and runs with Enter', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, overrides: { [COMMAND]: NAME } });
    const error = await h.tryRegister({
      id: COMMAND,
      label: COMMAND,
      group: 'ext',
      contextMenu: ['text'],
    });
    expect(error).toBeNull();
    await h.frames(2);
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    const menu = page.getByRole('menu', { name: 'Commands for the selection' });
    await expect(menu).toBeVisible();
    const item = menu.locator(`[data-menu-item][data-command-id="${COMMAND}"]`);
    await expect(item).toHaveAccessibleName(NAME);
    // Arrow keys reach the item from the first one in the menu.
    const count = await menu.locator('[data-menu-item]').count();
    let reached = false;
    for (let i = 0; i < count && !reached; i++) {
      reached = (await focused(page)).command === COMMAND;
      if (!reached) await page.keyboard.press('ArrowDown');
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await h.frames(2);
    expect(await h.commandRuns()).toContain(COMMAND);
  });
});
