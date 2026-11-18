/**
 * UX-020 criterion 2 (the pane's half): the outline changes while the author works in it. Focus stays
 * on the heading the author is on, and when that heading is removed, the place and the focus go to the
 * nearest heading before it instead of falling to the page. The harness's outline stands for the
 * core's `outline()` view; its own cost on the typing path is measured in the engine's tests.
 */
import { expect, open, test } from './helpers.ts';

test.describe('the outline pane keeps the author’s place (UX-020 criterion 2)', () => {
  test('moves the place and focus to the previous heading when the one it is on is removed', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    const tree = page.getByRole('tree', { name: 'Headings' });
    await tree.getByRole('treeitem', { name: 'Payment' }).focus();
    await expect(tree.getByRole('treeitem', { name: 'Payment' })).toBeFocused();
    await h.setOutline([
      { id: 'h1', level: 1, text: 'Scope' },
      { id: 'h2', level: 2, text: 'Terms' },
      { id: 'h4', level: 1, text: 'Annex' },
    ]);
    await expect(tree.getByRole('treeitem')).toHaveText(['Scope', 'Terms', 'Annex']);
    await expect(tree.getByRole('treeitem', { name: 'Terms' })).toBeFocused();
    // The tree still has one tab stop, on the place.
    await expect(tree.getByRole('treeitem', { name: 'Terms' })).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: 'Annex' })).toBeFocused();
  });

  test('does not take focus from the page when a heading is removed and the tree was not focused', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    const tree = page.getByRole('tree', { name: 'Headings' });
    await tree.getByRole('treeitem', { name: 'Payment' }).focus();
    await page.locator('.de-shell').getByRole('button').first().focus();
    await h.setOutline([
      { id: 'h1', level: 1, text: 'Scope' },
      { id: 'h2', level: 2, text: 'Terms' },
    ]);
    await expect(tree.getByRole('treeitem')).toHaveCount(2);
    await expect(tree.getByRole('treeitem', { name: 'Terms' })).not.toBeFocused();
  });
});
