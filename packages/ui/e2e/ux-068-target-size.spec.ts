/**
 * Pointer target size across the full toolbar's tabs (UX-068, criterion 2, extended). The earlier
 * shell-wcag test measured the first tab only. Here each tab of the full toolbar is opened in turn
 * and every visible control of the shell (header, toolbar, status bar and the tab's groups) is
 * measured against 24 by 24 CSS pixels (WCAG 2.2 2.5.8). Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-068-target-size`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

/** The visible controls of the shell that are smaller than 24 by 24 CSS pixels, and how many were measured. */
async function measureControls(page: Page): Promise<{ measured: number; small: string[] }> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const out: string[] = [];
    let measured = 0;
    const controls = root.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="tab"], [role="menuitem"], [role="radio"], [role="checkbox"], select, input:not([type="hidden"])',
    );
    for (const el of controls) {
      if (el.closest('.de-page, [data-content], [hidden]')) continue;
      if (el.getClientRects().length === 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      measured += 1;
      const box = el.getBoundingClientRect();
      if (box.width < 24 || box.height < 24) {
        out.push(
          `${el.tagName.toLowerCase()}.${el.className} ${Math.round(box.width)}x${Math.round(box.height)} "${(el.textContent ?? '').trim().slice(0, 30)}"`,
        );
      }
    }
    return { measured, small: out };
  });
}

test.describe('pointer targets on every tab of the full toolbar (UX-068, criterion 2)', () => {
  test('every visible control is at least 24 by 24 CSS pixels on each tab', async ({ page }) => {
    await open(page, { extended: true, toolbar: 'full', features: ['presence'], presence: [] });
    const tabs = page.locator('#host').locator('[role="tab"]');
    const count = await tabs.count();
    // The full toolbar has tabs to walk; zero tabs would pass the check vacuously.
    expect(count).toBeGreaterThan(1);

    const perTab: Array<{ tab: string; measured: number; small: string[] }> = [];
    for (let i = 0; i < count; i += 1) {
      const tab = tabs.nth(i);
      const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
      await tab.click();
      await page.waitForTimeout(50);
      const result = await measureControls(page);
      perTab.push({ tab: label, ...result });
    }

    // Each tab was measured, and no control on any tab is under the target size.
    for (const entry of perTab)
      expect(entry.measured, `controls on tab "${entry.tab}"`).toBeGreaterThan(0);
    expect(perTab.flatMap((e) => e.small.map((s) => `${e.tab}: ${s}`))).toEqual([]);
  });
});
