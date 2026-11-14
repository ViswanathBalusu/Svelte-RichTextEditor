/**
 * PRM-024 criterion 3 (lane U-PRM-018-034): when a permission rejection appears, the shell announces
 * it through its polite live region, and focus stays where it was (no focus is moved to the
 * message). The item itself is in the recovered-edits pane, checked in rejection-explained.spec.ts.
 */
import { axe, expect, focused, open, test } from './helpers.ts';

const AT = '2026-11-13T09:30:00.000Z';

test.describe('a rejection is announced without moving focus (PRM-024, criterion 3)', () => {
  test('the status live region reads the notice and focus is not moved', async ({ page }) => {
    const h = await open(page, { extended: true });
    await page.locator('.de-editing-surface').focus();
    const before = await focused(page);
    expect(before.className + before.tag).not.toBe('');

    await h.setAside([
      {
        id: 'i1',
        reason: 'permission_denied',
        commit: 'c1',
        text: 'My words',
        seq: 4,
        scope: 'region:r1',
        scopes: ['region:r1'],
        changedBy: 'u2',
        changedAt: AT,
      },
    ]);

    const live = page.locator('.de-shell > [role="status"]');
    await expect(live).toHaveText(/could not be saved because your permissions changed/);
    await expect(page.locator('.de-status [data-status="notice"]')).toContainText(
      'could not be saved because your permissions changed',
    );
    // The words of the refused change are not announced.
    await expect(live).not.toContainText('My words');

    // Focus is where it was before the rejection arrived.
    const after = await focused(page);
    expect(after).toEqual(before);
    expect(await axe(page)).toEqual([]);
  });
});
