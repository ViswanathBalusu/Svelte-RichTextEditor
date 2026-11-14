/**
 * FE-138: zoom the editing surface. The content scales and reflows while the interface keeps its
 * size (criterion 1); zoom in, zoom out and reset are reached with the Tab key and Enter, with no
 * pointer (criterion 4). Browser zoom (criterion 2) and the read view or PDF panel (criterion 3)
 * are not covered here. Run with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts e2e/fe-138-zoom.spec.ts`.
 */
import { expect, focused, open, test } from './helpers.ts';
import type { Page } from '@playwright/test';

/** Moves the keyboard focus with Tab (or Shift+Tab) until the control with this name has it. */
async function tabTo(page: Page, name: string, backwards = false): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await focused(page)).text === name) return;
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`focus did not reach "${name}"`);
}

test.describe('zoom the editing surface (FE-138)', () => {
  test('scales the content to the width and keeps the interface the same size', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const bar = page.locator('.de-status');
    const zoom = bar.getByRole('group', { name: 'Zoom' });
    const surface = page.locator('.de-editing-surface');
    const host = page.locator('.de-body-host');

    const barBefore = (await bar.boundingBox())!;
    const fontBefore = await bar.evaluate((el) => getComputedStyle(el).fontSize);
    const heightBefore = (await surface.boundingBox())!.height;

    // Three steps in: 150 per cent in the shell's own steps (see zoom.ts).
    for (let i = 0; i < 3; i++) await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('150%');

    const barAfter = (await bar.boundingBox())!;
    expect(barAfter.width).toBeCloseTo(barBefore.width, 0);
    expect(barAfter.height).toBeCloseTo(barBefore.height, 0);
    expect(await bar.evaluate((el) => getComputedStyle(el).fontSize)).toBe(fontBefore);

    // The content is larger, and it reflows: no horizontal scroll inside the body host.
    const heightAfter = (await surface.boundingBox())!.height;
    expect(heightAfter).toBeGreaterThan(heightBefore * 1.2);
    const overflow = await host.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // Zoom is a view state: no command of the core ran.
    expect(await h.runs()).toEqual([]);
    expect(await h.named()).toEqual([]);
  });

  test('reflows at the largest product zoom in a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await open(page, { extended: true });
    const zoom = page.locator('.de-status').getByRole('group', { name: 'Zoom' });
    for (let i = 0; i < 5; i++) await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('200%');
    const overflow = await page
      .locator('.de-body-host')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('zoom in, zoom out and reset are reached with Tab and Enter, without a pointer', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    const zoom = page.locator('.de-status').getByRole('group', { name: 'Zoom' });
    await page.locator('.de-editing-surface').focus();
    // Ctrl+F6 moves between the landmarks; step to the status bar first.
    for (let i = 0; i < 6; i++) {
      if ((await focused(page)).inside === 'status') break;
      await page.keyboard.press('Control+F6');
    }
    expect((await focused(page)).inside).toBe('status');

    await tabTo(page, 'Zoom out');
    await page.keyboard.press('Enter');
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('90%');

    await tabTo(page, 'Zoom in');
    await page.keyboard.press('Enter');
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('100%');
    await page.keyboard.press('Enter');
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('110%');

    await tabTo(page, 'Reset zoom');
    await page.keyboard.press('Enter');
    await expect(zoom.locator('[data-status="zoom"]')).toHaveText('100%');
    await expect(zoom.getByRole('button', { name: 'Reset zoom' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Zoom is a view state: no command of the core ran.
    expect(await h.runs()).toEqual([]);
  });
});
