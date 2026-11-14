/**
 * UX-023 criterion 2, the closed-pane case (lane V-UX-016-030): when a pane is closed, Ctrl+F6
 * skips it. The collapsed case is not tested here: the shell has no collapsed state for a pane
 * (see the story's Notes), so criterion 2 stays open.
 *
 * Run from packages/ui with DOCEDIT_UI_PORT=57260:
 * `pnpm exec playwright test -c playwright.config.ts e2e/ux-023-closed-pane.spec.ts`
 * (Chromium, Firefox and WebKit).
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

test.describe('landmarks by keyboard with a closed pane (UX-023 criterion 2)', () => {
  test('a closed pane is not a landmark and Ctrl+F6 skips it', async ({ page }) => {
    await open(page, { extended: true });
    await expect(page.locator('[data-landmark="pane"]')).toHaveCount(0);
    await focusSurface(page);
    const order: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Control+F6');
      order.push((await focused(page)).inside);
    }
    expect(order).toEqual(['status', 'header', 'toolbar', 'page']);
    expect(order).not.toContain('pane');
  });
});
