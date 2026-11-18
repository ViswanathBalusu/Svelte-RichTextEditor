/**
 * Changes that did not happen (11 §3 exit check; 07 §7, §9; FE-036; UX-017 criterion 6): a refusal
 * of the region guard and work the server rejected are shown in the status bar and announced in
 * the shell's polite live region, in plain words, naming no content (ADR 0019).
 */
import { axe, expect, open, test } from './helpers.ts';

test.describe('notices for changes that did not happen', () => {
  test('a refusal of the region guard is shown and announced, each time', async ({ page }) => {
    const h = await open(page);
    const live = page.locator('.de-shell > [role="status"]');
    const notice = page.locator('.de-status [data-status="notice"]');
    await expect(notice).toHaveCount(0);
    await h.refuse('scope', ['region:rSecret']);
    await expect(notice).toContainText(
      'That change was not made: you cannot change this part of the document.',
    );
    await expect(live).toHaveText(
      'That change was not made: you cannot change this part of the document.',
    );
    // The scope is never shown.
    await expect(notice).not.toContainText('rSecret');
    // The same reason again is a new notice and a new announcement (the region is emptied and
    // filled again, which screen readers announce).
    await page.evaluate(() => {
      const root = document.getElementById('host')!.shadowRoot!;
      const region = root.querySelector('.de-shell > [role="status"]')!;
      const w = window as unknown as { __announced: number };
      w.__announced = 0;
      new MutationObserver(() => {
        if (region.textContent?.trim()) w.__announced++;
      }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    await h.refuse('scope', ['region:rSecret']);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __announced: number }).__announced))
      .toBeGreaterThan(0);
    await expect(live).toHaveText(/you cannot change this part/);
    // Typing goes on: the notice took no focus.
    expect(
      await page.evaluate(() => document.getElementById('host')!.shadowRoot!.activeElement),
    ).toBeNull();
    expect(await axe(page)).toEqual([]);
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('a deletion a cross-reference names is explained and offers to show the references (FE-133)', async ({
    page,
  }) => {
    // The extended core has the named commands of phase 1b, `showReferences` among them.
    const h = await open(page, { extended: true });
    const notice = page.locator('.de-status [data-status="notice"]');
    await h.refuse('referenced', [], 2);
    await expect(notice).toContainText(
      'That change was not made: 2 cross-references still point to what you tried to delete.',
    );
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      /2 cross-references still point/,
    );
    expect(await axe(page)).toEqual([]);
    await notice.getByRole('button', { name: 'Show references' }).click();
    expect(await h.named()).toContainEqual(['showReferences', null]);
    // Another refusal has no such button.
    await h.refuse('scope', ['body']);
    await expect(notice.getByRole('button', { name: 'Show references' })).toHaveCount(0);
  });

  test('a rejected commit is shown with the number of changes kept', async ({ page }) => {
    const h = await open(page);
    await h.setAside([
      { reason: 'permission_denied', commit: 'c1', text: 'mine', seq: 3 },
      { reason: 'permission_denied', commit: 'c2', text: 'also mine', seq: 3 },
    ]);
    const notice = page.locator('.de-status [data-status="notice"]');
    await expect(notice).toContainText(
      '2 changes could not be saved because your permissions changed. They are kept in recovered edits.',
    );
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(/2 changes could not/);
    // The words of the change are not in the notice.
    await expect(notice).not.toContainText('mine');
    await h.refuse('placeholder');
    await expect(notice).toContainText('hidden from you cannot be changed, moved or copied');
  });
});
