/**
 * UX-020 criterion 3 (lane U-UX-016-030): a search lists its results with their context and a count,
 * and the match is marked. The harness's core searches its outline and the body text, so the context
 * of the one match is worked out here from the same body string.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

const BODY = 'Body text of the test document.';

test.describe('the navigation pane search results (UX-020 criterion 3)', () => {
  test('lists each match with the text around it, the match marked, and the count', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await h.exec('view.find');
    const field = page.getByRole('searchbox', { name: 'Search for' });
    await expect(field).toBeFocused();
    await field.fill('test');
    await page.keyboard.press('Enter');
    const results = page.getByRole('list', { name: 'Results' });
    await expect(results.getByRole('button')).toHaveCount(1);
    await expect(page.locator('[data-status="search"]')).not.toHaveText('No results');
    const i = BODY.indexOf('test');
    const expected = BODY.slice(Math.max(0, i - 12), i) + 'test' + BODY.slice(i + 4, i + 4 + 12);
    const item = results.getByRole('button').first();
    await expect(item.locator('[data-content]')).toHaveText(expected);
    await expect(item.locator('mark')).toHaveText('test');
    // The context is the text around the match, and it is not empty on either side.
    expect(expected.startsWith('text of the ')).toBe(true);
    expect(expected.endsWith(' document.')).toBe(true);
  });
});
