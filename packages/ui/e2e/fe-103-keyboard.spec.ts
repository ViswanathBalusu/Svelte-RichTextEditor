/**
 * Keyboard exit from the editing surface (FE-103 criteria 2 to 4; lane U-FE-097-112). In a real
 * browser on the shell harness: Escape leaves the editing surface; Tab then moves to the next
 * control in page order and Shift+Tab back to the previous one; the focused control is outlined
 * under forced colours. Criterion 1 (a scripted set of tasks done without a pointer) is not
 * checked here.
 *
 * Page order is taken as the order of the focusable controls of the shell's shadow root, followed
 * by the host page's own control after the editor (`#after`), which is the order Tab follows.
 */
import type { Page } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"], .de-editing-surface';

/** Index of the focused control in page order, or -1 when focus is not on one of them. */
function focusIndex(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const root = document.getElementById('host')!.shadowRoot!;
    const shell = [...root.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.getClientRects().length > 0,
    );
    const order: Element[] = [...shell, document.getElementById('after')!];
    const active = root.activeElement ?? document.activeElement;
    return active ? order.indexOf(active) : -1;
  }, FOCUSABLE);
}

/** The number of focusable controls of the shell in page order, with the host's control last. */
function controlCount(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const root = document.getElementById('host')!.shadowRoot!;
    return (
      [...root.querySelectorAll<HTMLElement>(selector)].filter(
        (el) => el.getClientRects().length > 0,
      ).length + 1
    );
  }, FOCUSABLE);
}

test.describe('keyboard exit from the editing surface (FE-103)', () => {
  test('Escape leaves the editing surface', async ({ page }) => {
    await open(page, { extended: true });
    await focusSurface(page);
    expect(await focusIndex(page)).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
    // Focus has left the editing surface: the shell no longer holds it.
    expect(await focusIndex(page)).toBe(-1);
    // Focus waits on the empty place after the surface (`.de-tab-origin`), so that Tab goes on from there.
    expect(
      await page.evaluate(
        () => document.getElementById('host')!.shadowRoot!.activeElement?.className ?? null,
      ),
    ).toBe('de-tab-origin');
  });

  test('after Escape, Tab moves to the next control in page order and Shift+Tab to the previous one', async ({
    page,
  }) => {
    await open(page, { extended: true });
    await focusSurface(page);
    const surface = await focusIndex(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    const next = await focusIndex(page);
    expect(next).toBeGreaterThan(surface);
    await page.keyboard.press('Shift+Tab');
    expect(await focusIndex(page)).toBe(surface);
    expect(await controlCount(page)).toBeGreaterThan(surface);
  });

  test('a control is outlined when it has focus under forced colours', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'forced colours are emulated in Chromium only');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page);
    await page.locator('h1').click();
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const active = document.getElementById('host')!.shadowRoot!.activeElement as HTMLElement;
      const style = getComputedStyle(active);
      return {
        style: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
        color: style.outlineColor,
      };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });
});
