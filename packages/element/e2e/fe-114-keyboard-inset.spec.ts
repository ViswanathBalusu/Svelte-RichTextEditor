/**
 * FE-114 criterion 1: on a touch device the visual viewport API keeps the caret above whatever
 * covers the bottom of the page. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-114-keyboard-inset.spec.ts --project=chromium --retries=0`.
 *
 * Playwright has no on-screen keyboard. What it can do in Chromium is shrink the visual viewport
 * for real: a pinch gesture sent through DevTools (`Input.synthesizePinchGesture`) at the top of the
 * screen gives a visual viewport that starts at the top and is half as high, so the bottom half of
 * the layout viewport lies outside it, which is the geometry an iOS keyboard gives. The element reads
 * `window.visualViewport` and the touch signal `(any-pointer: coarse)` and nothing else. The control
 * answers the touch signal "no": the caret then stays outside the visible part, so the move comes
 * from the element's code and not from the browser.
 *
 * This is Chromium's mobile emulation on the desktop machine at 390 by 844 CSS pixels. No keyboard,
 * no phone and no WebKit (it has no pinch gesture input in Playwright).
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const WIDTH = 390;
const HEIGHT = 844;

test.use({ viewport: { width: WIDTH, height: HEIGHT }, isMobile: true, hasTouch: true });

interface Geometry {
  scale: number;
  visibleTop: number;
  visibleBottom: number;
  caretTop: number;
  caretBottom: number;
  inset: string;
}

/** Fills the document so that it scrolls, and leaves the caret at the end of the last paragraph. */
async function typeLongDocument(page: Page): Promise<void> {
  await page.locator('doc-editor[data-test="one"] .de-editing-surface').click();
  await page.keyboard.press('ControlOrMeta+End');
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Line ${i} of a phone document.`);
  }
  // Scrolled to the end, as the browser leaves it after typing.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
}

function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('doc-editor[data-test="one"]')!;
    const root = host.shadowRoot as ShadowRoot & { getSelection(): Selection | null };
    const range = root.getSelection()!.getRangeAt(0);
    // A collapsed range after text has a rectangle; the one at the end of a text node is used.
    const rect = [...range.getClientRects()].at(-1) ?? range.getBoundingClientRect();
    const vv = window.visualViewport!;
    return {
      scale: vv.scale,
      visibleTop: vv.offsetTop,
      visibleBottom: vv.offsetTop + vv.height,
      caretTop: rect.top,
      caretBottom: rect.bottom,
      inset: host.style.getPropertyValue('--de-keyboard-inset'),
    };
  });
}

async function pinchAtTop(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', {
    x: WIDTH / 2,
    y: 4,
    scaleFactor: 2,
    relativeSpeed: 800,
  });
  await expect
    .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
    .toBeGreaterThan(1.5);
  // The element reacts to the `resize` event of the visual viewport and the next frame.
  await page.waitForTimeout(300);
}

test.describe('FE-114: the caret stays above what covers the bottom of the page', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'the pinch gesture is sent through Chromium DevTools');
  });

  test('a visual viewport that shrinks puts the caret inside the visible part, and gives room below the body', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { sub: 'ada', role: 'editor', name: 'one' });
    await typeLongDocument(page);
    const before = await geometry(page);
    expect(before.inset).toBe('');

    await pinchAtTop(page);
    const after = await geometry(page);
    // The visible part is about half as high, and begins at the top.
    expect(after.visibleBottom - after.visibleTop).toBeLessThan(HEIGHT * 0.7);
    expect(after.caretBottom).toBeLessThanOrEqual(after.visibleBottom);
    expect(after.caretTop).toBeGreaterThanOrEqual(after.visibleTop);
    expect(Number.parseInt(after.inset, 10)).toBeGreaterThan(HEIGHT * 0.3);

    // Typing on moves the caret down; it is followed.
    await page.keyboard.press('Enter');
    await page.keyboard.type('One more line.');
    await page.waitForTimeout(300);
    const typed = await geometry(page);
    expect(typed.caretBottom).toBeLessThanOrEqual(typed.visibleBottom);
    expect(typed.caretTop).toBeGreaterThanOrEqual(typed.visibleTop);
  });

  test('control: without the touch signal the caret is left outside the visible part', async ({
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
    await mountEditor(page, { sub: 'ada', role: 'editor', name: 'one' });
    await typeLongDocument(page);
    await pinchAtTop(page);
    const after = await geometry(page);
    expect(after.inset).toBe('');
    expect(after.caretBottom).toBeGreaterThan(after.visibleBottom);
  });
});
