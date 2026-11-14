/**
 * The context menu's keyboard and names (UX-008, criterion 2, lane U-UX-001-015): every item has
 * an accessible name, the arrow keys move between all items, and Escape closes the menu and
 * returns focus to the editing surface. The opening and the pointer position are tested in
 * commands.spec.ts (UX-008).
 */
import { expect, focused, open, test } from './helpers.ts';

test.describe('the context menu keyboard and names (UX-008)', () => {
  test('every item has an accessible name; arrows reach each one; Escape returns to the text', async ({
    page,
  }) => {
    await open(page, { extended: true });
    await page
      .locator('.de-editing-surface')
      .click({ button: 'right', position: { x: 30, y: 10 } });
    const menu = page.getByRole('menu', { name: 'Commands for the selection' });
    await expect(menu).toBeVisible();
    const items = menu.locator('[data-menu-item]');
    const count = await items.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      await expect(items.nth(i)).toHaveAccessibleName(/\S/);
    }
    const ids = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-command-id')));
    // Arrow down visits every item once, in order.
    const visited: Array<string | null> = [(await focused(page)).command];
    for (let i = 1; i < count; i++) {
      await page.keyboard.press('ArrowDown');
      visited.push((await focused(page)).command);
    }
    expect(visited).toEqual(ids);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });
});
