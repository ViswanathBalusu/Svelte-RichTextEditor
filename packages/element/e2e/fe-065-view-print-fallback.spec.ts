/**
 * FE-065 criterion 4: given `view="print"` while the page view is not available, the element shows
 * the web view, says why and does not throw. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-065-view-print-fallback.spec.ts`
 * (Chromium, Firefox and WebKit).
 *
 * The page view (FE-101) is not offered where canvas measurement is not good enough (spike S5:
 * Firefox), and that is decided from the user agent, so the test gives every browser a Firefox user
 * agent. The editing surface must be mounted and shown, no page view or read view may be in the
 * shadow root, the notice must say why, and the page must raise no uncaught error. The desktop
 * viewport is the default of each project; the touch case is e2e/fe-113-touch-view-choice.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

test.use({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
});

test('view="print" with no page view shows the web view and throws nothing (FE-065, criterion 4)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });

  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'print' } });

  await expect
    .poll(() =>
      page.evaluate(
        (sel) =>
          document.querySelector(sel)!.shadowRoot!.querySelectorAll('.de-view-notice').length,
        editor,
      ),
    )
    .toBe(1);
  const shown = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    return {
      webSurface: root.querySelectorAll('.de-editing-surface').length,
      pageView: root.querySelectorAll('.de-page-view').length,
      readView: root.querySelectorAll('.de-read-view').length,
      notice: root.querySelector('.de-view-notice')?.textContent ?? '',
    };
  }, editor);

  expect(shown.webSurface).toBe(1);
  expect(shown.pageView).toBe(0);
  expect(shown.readView).toBe(0);
  // The reason is the measurement, or the kernel's own failure when it came first (WASM-003).
  expect(shown.notice).toContain('The page view is not available.');
  expect(errors).toEqual([]);
});
