/**
 * FE-138 criterion 2 (lane V-FE-129-141): browser zoom and the product's zoom together. Browser
 * zoom changes the CSS width of the window and not the layout rules, so a window of 640 CSS pixels
 * is what a 1280 pixel window shows at 200 per cent, and 320 CSS pixels is the WCAG 1.4.10 reflow
 * width. The web view must reflow in both, with and without the product's own zoom on top.
 * Run with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts e2e/v-fe-129-141-browser-zoom.spec.ts`.
 */
import { expect, open, test } from './helpers.ts';
import type { Page } from '@playwright/test';

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function hostOverflow(page: Page): Promise<number> {
  return page.locator('.de-body-host').evaluate((el) => el.scrollWidth - el.clientWidth);
}

test.describe('browser zoom with the product zoom (FE-138 criterion 2, FE-106)', () => {
  test('reflows at 320 CSS pixels, the WCAG reflow width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, { extended: true });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
    expect(await hostOverflow(page)).toBeLessThanOrEqual(1);
    const surface = (await page.locator('.de-editing-surface').boundingBox())!;
    expect(surface.width).toBeLessThanOrEqual(320);
  });

  test('reflows at 640 CSS pixels with the product zoom at 150 per cent on top', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await open(page, { extended: true });
    const zoom = page.locator('.de-status').getByRole('group', { name: 'Zoom' });
    for (let i = 0; i < 3; i++) await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('150%');
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
    expect(await hostOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('keeps the product zoom working at the 320 CSS pixel width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, { extended: true });
    const zoom = page.locator('.de-status').getByRole('group', { name: 'Zoom' });
    for (let i = 0; i < 5; i++) await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('200%');
    expect(await hostOverflow(page)).toBeLessThanOrEqual(1);
  });
});
