/**
 * Visual regression of the mirrored shell in the right-to-left pseudo-locale (UX-064, criterion 7;
 * lane V-UX-061-075).
 *
 * The toolbar and the status bar of `ar-XB` are compared with screenshots stored beside this file
 * (`ux-064-rtl-visual.spec.ts-snapshots/`, one per browser and platform). The geometric checks that
 * no control clips, overlaps or sits on the left-to-right side are in strings.spec.ts; this test
 * adds the pixel comparison, which those checks do not make, and first checks in the same run that
 * the toolbar it captures is mirrored (its first control at the inline start, on the right).
 *
 * Baselines exist for Chromium, Firefox and WebKit on Windows (win32) and on Linux (linux, recorded
 * in a Playwright v1.65.0 container under Podman, lane V-UX-061-075, 2026-11-14); none on macOS. On a platform or browser
 * without a stored baseline the test is skipped with that reason rather than failing, unless
 * snapshots are being recorded (`--update-snapshots`), which writes that platform's baselines. A
 * baseline guards against change; it does not by itself show the mirroring is right, which is why
 * the geometric checks stay the main evidence.
 *
 * Run with `DOCEDIT_UI_PORT=57040 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-064-rtl-visual`.
 * To record the baselines: the same command with `--update-snapshots`.
 */
import { existsSync } from 'node:fs';
import { expect, open, test } from './helpers.ts';

const shots = ['ux-064-ar-XB-toolbar.png', 'ux-064-ar-XB-status.png'] as const;

/**
 * Playwright's WebKit screenshotter briefly inserts `<style>body {}</style>` from its utility world
 * to resynchronise animations (playwright-core 1.65, screenshotter `inPagePrepareForScreenshots`,
 * `shouldToggleStyleSheetToSyncAnimations` is true only for WebKit). Under the harness's strict
 * policy that insertion is reported as a `style-src-elem` violation although the page did nothing.
 * Only that exact report is recognised as the test tool's own.
 */
function isScreenshotterArtefact(violation: string): boolean {
  return violation.startsWith('style-src-elem inline ') && violation.endsWith(' "body {}"');
}

test.describe('the mirrored shell has no visual regression (UX-064, criterion 7)', () => {
  test('the toolbar and the status bar in ar-XB match their stored screenshots', async ({
    page,
    browserName,
  }, testInfo) => {
    const recording =
      testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
    const missing = shots.filter(
      (name) => !existsSync(testInfo.snapshotPath(name, { kind: 'screenshot' })),
    );
    // The Linux baselines were recorded in the Playwright container, whose fonts a hosted runner
    // does not have (the first hosted run differed by 2,165 pixels in the toolbar). CI runs this
    // spec in that container (the job "visual", scripts/ci/visual-in-container.sh), which sets this.
    test.skip(
      !recording &&
        process.platform === 'linux' &&
        process.env['DOCEDIT_PLAYWRIGHT_CONTAINER'] !== '1',
      'the Linux baselines are pixel-exact only in the Playwright container (scripts/ci/visual-in-container.sh)',
    );
    test.skip(
      !recording && missing.length > 0,
      `no stored baseline for ${browserName} on ${process.platform}; baselines exist for win32 only (record with --update-snapshots)`,
    );

    await open(page, { width: 1000, locale: 'ar-XB' });
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('toolbar')).toHaveAttribute('lang', 'ar-XB');

    // The captured toolbar is the mirrored one: its first control sits at the right-hand edge.
    const toolbar = await page.locator('.de-toolbar').boundingBox();
    const first = await page.locator('.de-toolbar').getByRole('button').first().boundingBox();
    expect(toolbar).not.toBeNull();
    expect(first).not.toBeNull();
    expect(toolbar!.x + toolbar!.width - (first!.x + first!.width)).toBeLessThan(40);

    // The page itself has caused no policy violation before the screenshots are taken.
    const harnessViolations = (): Promise<string[]> =>
      page.evaluate(() => [
        ...(window as unknown as { harness: { violations: string[] } }).harness.violations,
      ]);
    expect(await harnessViolations()).toEqual([]);

    await page.mouse.move(0, 0);
    const options = { animations: 'disabled' as const, caret: 'hide' as const };
    await expect(page.locator('.de-toolbar')).toHaveScreenshot(shots[0], options);
    await expect(page.locator('.de-status')).toHaveScreenshot(shots[1], options);

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
