/**
 * Visual regression of the ribbon layout (`toolbar="ribbon"`, ADR 0490; UX-064 criterion 7 by
 * analogy). The tabs and the groups of Home, in the light and the dark theme, and the status bar are
 * compared with screenshots stored beside this file (`ux-064-ribbon-visual.spec.ts-snapshots/`, one
 * per browser and platform). The compact layout's baselines (`ux-064-rtl-visual.spec.ts`) are not
 * touched by the ribbon.
 *
 * Baselines are recorded in the Playwright container, as those of the right-to-left spec are
 * (scripts/ci/visual-in-container.sh, with `--update-snapshots --grep ribbon`); none for Windows or
 * macOS yet. On a platform or browser without a stored baseline the test is skipped with that reason
 * rather than failing, unless snapshots are being recorded. On Linux it runs only in the container,
 * whose fonts the baselines depend on (`DOCEDIT_PLAYWRIGHT_CONTAINER=1`).
 *
 * Run with `DOCEDIT_UI_PORT=57040 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-064-ribbon-visual`.
 */
import { existsSync } from 'node:fs';
import { expect, open, test } from './helpers.ts';

const shots = [
  'ux-064-ribbon-home-light.png',
  'ux-064-ribbon-home-dark.png',
  'ux-064-ribbon-status.png',
] as const;

/** See `ux-064-rtl-visual.spec.ts`: WebKit's screenshotter inserts a style the policy reports. */
function isScreenshotterArtefact(violation: string): boolean {
  return violation.startsWith('style-src-elem inline ') && violation.endsWith(' "body {}"');
}

test.describe('the ribbon layout has no visual regression (UX-064)', () => {
  test('the Home tab in light and dark, and the status bar, match their stored screenshots', async ({
    page,
    browserName,
  }, testInfo) => {
    const recording =
      testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
    const missing = shots.filter(
      (name) => !existsSync(testInfo.snapshotPath(name, { kind: 'screenshot' })),
    );
    test.skip(
      !recording &&
        process.platform === 'linux' &&
        process.env['DOCEDIT_PLAYWRIGHT_CONTAINER'] !== '1',
      'the Linux baselines are pixel-exact only in the Playwright container (scripts/ci/visual-in-container.sh)',
    );
    test.skip(
      !recording && missing.length > 0,
      `no stored baseline for ${browserName} on ${process.platform}; baselines are recorded in the Playwright container (linux)`,
    );

    const options = { animations: 'disabled' as const, caret: 'hide' as const };
    const harnessViolations = (): Promise<string[]> =>
      page.evaluate(() => [
        ...(window as unknown as { harness: { violations: string[] } }).harness.violations,
      ]);

    await open(page, { toolbar: 'ribbon', extended: true, width: 1000 });
    await expect(page.locator('.de-shell')).toHaveAttribute('data-toolbar', 'ribbon');
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    expect(await harnessViolations()).toEqual([]);
    await page.mouse.move(0, 0);
    await expect(page.locator('.de-ribbon')).toHaveScreenshot(shots[0], options);
    await expect(page.locator('.de-status')).toHaveScreenshot(shots[2], options);

    await open(page, { toolbar: 'ribbon', extended: true, width: 1000, theme: 'dark' });
    await expect(page.locator('.de-shell')).toHaveAttribute('data-theme', 'dark');
    await page.mouse.move(0, 0);
    await expect(page.locator('.de-ribbon')).toHaveScreenshot(shots[1], options);

    // Remove only the WebKit screenshotter's own report, so the shared check in helpers.ts still
    // fails on anything else.
    if (browserName === 'webkit') {
      const after = await harnessViolations();
      expect(after.filter((v) => !isScreenshotterArtefact(v))).toEqual([]);
      await page.evaluate(() => {
        const list = (window as unknown as { harness: { violations: string[] } }).harness
          .violations;
        for (let i = list.length - 1; i >= 0; i--) {
          const v = list[i]!;
          if (v.startsWith('style-src-elem inline ') && v.endsWith(' "body {}"')) list.splice(i, 1);
        }
      });
    }
  });
});
