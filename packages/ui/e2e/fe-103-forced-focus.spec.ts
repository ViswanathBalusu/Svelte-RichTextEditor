/**
 * FE-103 criterion 4 (lane V-FE-097-112): every control of the shell that takes focus is outlined
 * under forced colours, not only the first one (the earlier test in e2e/fe-103-keyboard.spec.ts
 * checks the first toolbar control in Chromium). The test moves focus with Tab through the shell,
 * one control at a time, from the page's heading, and reads the computed outline of each focused
 * element under `forced-colors: active`. Forced colours drop box-shadow and most backgrounds, so an
 * outline of at least 2 CSS pixels is the visible indicator it checks. Run from the repository root
 * with `pnpm exec playwright test -c packages/ui/playwright.config.ts e2e/fe-103-forced-focus.spec.ts`.
 */
import { expect, open, test } from './helpers.ts';

interface Seen {
  label: string;
  outlineStyle: string;
  outlineWidth: number;
}

test.describe('focus indicator under forced colours (FE-103, criterion 4)', () => {
  test('every shell control that takes focus has a visible outline', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await expect
      .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
      .toBe(true);
    await open(page, { extended: true });
    await page.locator('h1').click();

    const seen: Seen[] = [];
    // The shell's controls come first in page order; Tab leaves the shell after the last one.
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab');
      const now = await page.evaluate(() => {
        const root = document.getElementById('host')!.shadowRoot!;
        const active = root.activeElement as HTMLElement | null;
        if (!active) return null;
        const style = getComputedStyle(active);
        const name =
          active.getAttribute('aria-label') ??
          active.getAttribute('data-command-id') ??
          active.className ??
          active.tagName;
        return {
          label: `${active.tagName.toLowerCase()} ${name}`.trim(),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
        };
      });
      if (now === null) {
        if (seen.length > 0) break;
        continue;
      }
      seen.push(now);
    }

    console.log(`FE-103 criterion 4: ${seen.length} focusable controls checked`);
    expect(seen.length, 'the shell has focusable controls').toBeGreaterThan(3);
    const unoutlined = seen.filter((s) => s.outlineStyle === 'none' || s.outlineWidth < 2);
    expect(unoutlined.map((s) => s.label)).toEqual([]);
  });
});
