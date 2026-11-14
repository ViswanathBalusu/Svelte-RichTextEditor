/**
 * The classification label in the status bar (UX-085 criterion 2; 13 §3, §10). The harness's core
 * offers the optional `classification` view; `setClassification` changes it as a core does when
 * `document.updated` brings a new label. The element's own core does not offer the view yet, so
 * this run proves the shell's side only.
 */
import { axe, expect, open, test } from './helpers.ts';

test.describe('the classification label (UX-085)', () => {
  test('is shown as text in the status bar and follows a change live', async ({ page }) => {
    const h = await open(page, { classification: { name: '  Internal   use only ' } });
    const label = page.locator('.de-status [data-status="classification"]');
    await expect(label).toBeVisible();
    // Text, not colour alone: the words are in the bar, with the name as the tenant wrote it.
    await expect(label).toHaveText('Classification: Internal use only');
    expect(await label.evaluate((el) => el.children.length)).toBe(0);
    expect(await axe(page)).toEqual([]);
    // A change reaches the open editor without a reload.
    await h.setClassification({ name: 'Confidential' });
    await expect(label).toHaveText('Classification: Confidential');
    // The name is content: markup in it is shown as text, never parsed.
    await h.setClassification({ name: '<img src=x onerror="window.__pwned=1">' });
    await expect(label).toHaveText('Classification: <img src=x onerror="window.__pwned=1">');
    expect(await page.evaluate(() => 'pwned' in window || '__pwned' in window)).toBe(false);
    // A removed or blank label leaves no empty marking.
    await h.setClassification({ name: '   ' });
    await expect(label).toHaveCount(0);
    await h.setClassification({ name: 'Restricted' });
    await expect(label).toHaveText('Classification: Restricted');
    await h.setClassification(null);
    await expect(label).toHaveCount(0);
  });

  test('shows nothing when the core offers no classification view', async ({ page }) => {
    await open(page);
    await expect(page.locator('.de-status')).toBeVisible();
    await expect(page.locator('.de-status [data-status="classification"]')).toHaveCount(0);
  });
});
