/**
 * The context menu offers the commands of each target the selection is in (UX-008, criterion 1,
 * lane V-UX-001-015): a picture, a field and a comment as well as text and a table. Each target
 * gets its own extension command with `contextMenu: [target]`; the menu opened on that target
 * lists it, and the menu opened on text does not. Run with
 * `DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-008-context-targets.spec.ts`.
 */
import { expect, open, test } from './helpers.ts';

const TARGETS = ['picture', 'field', 'comment'] as const;

test.describe('the context menu for each target (UX-008, criterion 1)', () => {
  for (const target of TARGETS) {
    test(`the ${target} target lists its command, and the text menu does not`, async ({ page }) => {
      const h = await open(page, { extended: true });
      const id = `ext.${target}Tool`;
      await h.register(id, 'command.format.bold', false, { contextMenu: [target] });
      const surface = page.locator('.de-editing-surface');

      // The selection is in the text only: the target's command is not offered.
      await surface.click({ button: 'right', position: { x: 30, y: 10 } });
      const menu = page.getByRole('menu', { name: 'Commands for the selection' });
      await expect(menu).toBeVisible();
      await expect(menu.locator(`[data-command-id="${id}"]`)).toHaveCount(0);
      await expect(menu.locator('[data-command-id="format.bold"]')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // The selection moves into the target: the menu lists its command, and the text commands.
      await h.setSelection({ contexts: [target] });
      await h.frames(2);
      await surface.click({ button: 'right', position: { x: 30, y: 10 } });
      await expect(menu).toBeVisible();
      await expect(menu.locator(`[data-command-id="${id}"]`)).toBeVisible();
      await expect(menu.locator('[data-command-id="format.bold"]')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });
  }
});
