/**
 * An arrival in the recovered edits is announced to assistive technology (UX-017, criterion 6, FE-107;
 * lane U-UX-016-030). The shell's live region (role="status") receives the notice when items are
 * set aside, and receives it again for a later arrival. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-017-recovered-announce`.
 */
import { expect, open, test } from './helpers.ts';

const first = [{ id: 'a1', reason: 'rebase', commit: null, text: 'First set aside', seq: 4 }];
const second = [{ id: 'a2', reason: 'rebase', commit: null, text: 'Second set aside', seq: 5 }];

// The shell's words for a set-aside change (the rebase reason, as the notice names it).
const KEPT = /kept in recovered edits/i;

test.describe('recovered edits are announced (UX-017 criterion 6)', () => {
  test('a new set-aside item is announced in the status live region, and a later one again', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const live = page.locator('.de-shell [role="status"]').first();
    // Record every text the live region takes, so a repeated message is seen as announced again.
    await page.evaluate(() => {
      const region = document
        .getElementById('host')!
        .shadowRoot!.querySelector<HTMLElement>('.de-shell [role="status"]')!;
      const seen: string[] = [];
      (window as unknown as { __announced: string[] }).__announced = seen;
      new MutationObserver(() => {
        const text = region.textContent?.trim() ?? '';
        if (text) seen.push(text);
      }).observe(region, { childList: true, characterData: true, subtree: true });
    });

    await h.setAside(first);
    await expect(live).toContainText(KEPT);
    await h.setAside([...first, ...second]);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __announced: string[] }).__announced.length),
      )
      .toBeGreaterThanOrEqual(2);
    const announced = await page.evaluate(
      () => (window as unknown as { __announced: string[] }).__announced,
    );
    expect(announced.filter((t) => KEPT.test(t)).length).toBeGreaterThanOrEqual(2);
  });
});
