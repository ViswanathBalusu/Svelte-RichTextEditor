/**
 * FE-065 criterion 4 (lane U-FE-065-080): given `view="print"` while the page view is not available,
 * the element shows the web view and does not throw. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-065-view-print-fallback.spec.ts`
 * (Chromium, Firefox and WebKit).
 *
 * The page view is FE-101's and is not built, so the element has one view, the web view, and the
 * check is that its editing surface is mounted, that no page view or read view is in the shadow root,
 * and that the page raised no uncaught error while the element mounted. The desktop viewport is the
 * default of each project; the touch case is e2e/fe-113-touch-view-choice.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

test('view="print" with no page view shows the web view and throws nothing (FE-065, criterion 4)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'print' } });

  const shown = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    return {
      webSurface: root.querySelectorAll('.de-editing-surface').length,
      pageView: root.querySelectorAll('[data-view="print"], .de-page-view').length,
      readView: root.querySelectorAll('[data-view="read"], .de-read-view').length,
    };
  }, editor);

  expect(shown.webSurface).toBe(1);
  expect(shown.pageView).toBe(0);
  expect(shown.readView).toBe(0);
  expect(errors).toEqual([]);
});
