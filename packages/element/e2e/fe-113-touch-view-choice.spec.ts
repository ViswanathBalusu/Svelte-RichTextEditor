/**
 * FE-113 criterion 2 (lane U-FE-097-112; fixed in U4 group 2, round 2): on a touch device, whatever
 * `view` is requested, the web view is shown. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-113-touch-view-choice.spec.ts e2e/fe-113-desktop-view-choice.spec.ts --project=chromium --project=firefox --project=webkit`.
 *
 * The element takes a coarse pointer (`(any-pointer: coarse)`) as touch input and passes it to
 * `selectView` (src/doc-editor.ts `#viewChoice`, src/view-select.ts). On a desktop `view="read"`
 * shows the read view (e2e/fe-113-desktop-view-choice.spec.ts); here the same attribute must show
 * the web view, so this case fails if the element stops applying the touch decision.
 *
 * Touch emulation per browser:
 * - Chromium: Playwright's phone emulation (390 by 844 CSS pixels, `hasTouch`, `isMobile`).
 * - Firefox: Playwright has no mobile emulation for Firefox, and `hasTouch` alone gives a fine
 *   pointer. Firefox's own preferences for the pointer media queries and touch points
 *   (`ui.primaryPointerCapabilities`, `ui.allPointerCapabilities`, `dom.maxtouchpoints.testing.value`)
 *   make the browser report a coarse pointer, which is what the element reads.
 * - WebKit: if Playwright's WebKit build on this platform reports no coarse pointer, the case is
 *   skipped with that reason (recorded in FE-113's Notes).
 *
 * `view="print"` also gives the web view on a desktop while the page view is not built (FE-101), so
 * for that value this test checks the outcome only; `read` is the value that tells the two apart.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { mountWithView } from './fe-113-view-choice-helpers.ts';

// Firefox pointer capability flags (widget/LookAndFeel.h): 1 is a coarse pointer.
const COARSE = 1;

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  launchOptions: {
    firefoxUserPrefs: {
      'ui.primaryPointerCapabilities': COARSE,
      'ui.allPointerCapabilities': COARSE,
      'dom.maxtouchpoints.testing.value': 5,
    },
  },
});

for (const view of ['read', 'print', 'web']) {
  test(`on a touch device, view="${view}" shows the web view`, async ({ page, browserName }) => {
    await openEmbed(page);
    const shown = await mountWithView(page, view);
    test.skip(
      !shown.coarsePointer,
      `${browserName} reports no coarse pointer in this emulation (maxTouchPoints ${shown.maxTouchPoints}), so no touch device is emulated`,
    );
    expect(shown.webSurface).toBe(1);
    expect(shown.readView).toBe(0);
    expect(shown.pageView).toBe(0);
  });
}

// The cause, in the same emulation: when the element's touch signal is answered "no" (the page's
// `matchMedia` for `(any-pointer: coarse)` reports false), `view="read"` shows the read view again.
// So the web view above comes from the touch decision and not from something else in the emulation.
test('in the same emulation with the coarse-pointer query answered false, view="read" shows the read view', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const list = real(query);
      if (!query.includes('pointer: coarse')) return list;
      return new Proxy(list, {
        get: (target, key) =>
          key === 'matches' ? false : (Reflect.get(target, key, target) as unknown),
      });
    };
  });
  await openEmbed(page);
  const shown = await mountWithView(page, 'read');
  expect(shown.coarsePointer).toBe(false);
  expect(shown.readView).toBe(1);
  expect(shown.webSurface).toBe(0);
});
