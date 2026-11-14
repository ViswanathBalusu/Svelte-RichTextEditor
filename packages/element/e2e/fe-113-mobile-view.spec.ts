/**
 * FE-113 criterion 1 (lane U-FE-113-128): on a phone-width viewport the document reflows with no
 * horizontal scrolling, scrolls by touch and can be pinch-zoomed. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-113-mobile-view.spec.ts`.
 *
 * The viewport is 390 by 844 CSS pixels with touch and the mobile flag, in every project. Reflow is
 * measured in all browsers. Touch scrolling and pinch-zoom are sent as Chromium DevTools input
 * gestures (`Input.synthesizeScrollGesture`, `Input.synthesizePinchGesture`), so they run in the
 * Chromium project only; WebKit has no such gesture input in Playwright. Criteria 2 to 4 (the touch
 * decision wired into the element, the iOS Safari and Chrome Android runs, and touch target sizes)
 * are not covered here.
 */
import { type Page, expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

const WIDTH = 390;
const HEIGHT = 844;
const LONG_WORD = 'W'.repeat(120);

test.use({ viewport: { width: WIDTH, height: HEIGHT }, isMobile: true, hasTouch: true });

interface Reflow {
  viewport: number;
  pageScrollWidth: number;
  surfaceScrollWidth: number;
  surfaceClientWidth: number;
  overflowing: string[];
}

function measure(page: Page): Promise<Reflow> {
  return page.evaluate((width) => {
    const host = document.querySelector('doc-editor')!;
    const surface = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
    return {
      viewport: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      surfaceScrollWidth: surface.scrollWidth,
      surfaceClientWidth: surface.clientWidth,
      overflowing: [...surface.querySelectorAll('p')]
        .filter((p) => p.getBoundingClientRect().right > width + 0.5)
        .map((p) => (p.textContent ?? '').slice(0, 20)),
    };
  }, WIDTH);
}

test('the document reflows at a phone width with no horizontal scrolling', async ({ page }) => {
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`A long line ${LONG_WORD} and then ordinary words that wrap.`);

  const layout = await measure(page);
  expect(layout.viewport).toBe(WIDTH);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(WIDTH);
  expect(layout.surfaceScrollWidth).toBeLessThanOrEqual(layout.surfaceClientWidth + 1);
  expect(layout.overflowing).toEqual([]);
});

test('the document scrolls by touch and can be pinch-zoomed', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch gestures are sent through Chromium DevTools input');
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Paragraph ${i} of a long phone document.`);
  }
  const cdp = await page.context().newCDPSession(page);

  const scrollBefore = await page.evaluate(() => window.scrollY);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: WIDTH / 2,
    y: HEIGHT * 0.7,
    yDistance: -400,
    speed: 800,
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);

  await cdp.send('Input.synthesizePinchGesture', {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    scaleFactor: 2,
    relativeSpeed: 800,
  });
  await expect
    .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
    .toBeGreaterThan(1.2);
});
