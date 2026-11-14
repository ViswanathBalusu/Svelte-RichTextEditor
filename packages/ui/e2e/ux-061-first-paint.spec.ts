/**
 * The resolved theme is in place before the first paint (UX-061, criterion 6, lane V-UX-061-075).
 *
 * A paint can only happen between tasks. So the check mounts the shell in one synchronous
 * JavaScript call and reads the theme attribute and the computed background in that same call,
 * before the browser has any chance to render. If the theme were applied in a later frame, the
 * synchronous read would show no theme, or the light one, under a dark setting.
 * Run from the repository root with
 * `DOCEDIT_UI_PORT=57293 DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm exec playwright test -c packages/ui/playwright.config.ts ux-061-first-paint --workers=1 --output <scratchpad>`.
 */
import { expect, test } from './helpers.ts';

const LIGHT_SURFACE = 'rgb(255, 255, 255)';
const DARK_SURFACE = 'rgb(22, 25, 29)';

test.describe('the resolved theme is applied before the first paint (UX-061, criterion 6)', () => {
  for (const [theme, background] of [
    ['light', LIGHT_SURFACE],
    ['dark', DARK_SURFACE],
  ] as const) {
    test(`${theme}: the shell has its theme in the same task that mounts it`, async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => 'harness' in window);
      const sync = await page.evaluate((t) => {
        const h = (window as unknown as { harness: { mount(o: object): void } }).harness;
        h.mount({ theme: t, extended: true });
        const host = document.getElementById('host')!;
        const shell = host.shadowRoot!.querySelector<HTMLElement>('.de-shell')!;
        // Read synchronously: no frame, no microtask and no timer has run since the mount.
        return {
          theme: shell.getAttribute('data-theme'),
          background: getComputedStyle(shell).backgroundColor,
        };
      }, theme);
      expect(sync).toEqual({ theme, background });
      await page.locator('.de-shell').first().waitFor();
    });
  }
});
