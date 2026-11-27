/**
 * FE-090 criterion 3 (the DOM half): the page view's text is real text, drawn as DOM and not on a
 * canvas, found by a text search, in the accessibility tree, and sharp when the device pixel ratio
 * (the zoom) goes up. Sharpness is measured on a screenshot of one painted line: the share of
 * half-tone pixels among the pixels that carry ink. Text that is drawn again at a higher scale has
 * thick strokes with a few edge pixels, so the share falls; a bitmap that is scaled up keeps its
 * soft edges, so the share would not fall.
 *
 * What an assistive technology reads is the manual screen-reader pass of FE-099 criterion 1 and is
 * not tested here.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57090 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-090-real-text.spec.ts`.
 * Firefox does not offer the page view (S5), so the tests are skipped there.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

async function desktopPointer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
}

async function openPageView(page: Page): Promise<void> {
  await desktopPointer(page);
  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'print' } });
  await expect
    .poll(() =>
      page.evaluate(
        (sel) => document.querySelector(sel)!.shadowRoot!.querySelectorAll('.de-line').length,
        editor,
      ),
    )
    .toBeGreaterThan(0);
}

/** The painted line with the most text: its text, its width, and a PNG of its box. */
async function longestLine(page: Page): Promise<{ text: string; width: number; png: string }> {
  const handle = await page.evaluateHandle((sel) => {
    const lines = [
      ...document.querySelector(sel)!.shadowRoot!.querySelectorAll<HTMLElement>('.de-line'),
    ];
    return lines.sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0]!;
  }, editor);
  const el = handle.asElement()!;
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const text = (await el.textContent()) ?? '';
  const png = (await el.screenshot()).toString('base64');
  return { text, width: box.width, png };
}

/** The share of half-tone pixels among the pixels that carry ink, decoded in the page. */
function halftoneShare(page: Page, png: string): Promise<{ ink: number; share: number }> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    let half = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      if (lum < 200) {
        ink++;
        if (lum > 50) half++;
      }
    }
    return { ink, share: ink === 0 ? 1 : half / ink };
  }, png);
}

test.describe('the page view paints real text (FE-090 criterion 3, the DOM half)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (S5)');
  });

  test('the lines are text nodes in the shadow root, with no canvas, and the text is found and in the accessibility tree', async ({
    page,
  }) => {
    await openPageView(page);
    const facts = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const lines = [...root.querySelectorAll<HTMLElement>('.de-page-view .de-line')];
      return {
        canvases: root.querySelectorAll('.de-page-view canvas').length,
        lines: lines.length,
        withTextNode: lines.filter((l) =>
          [...l.querySelectorAll('*'), l].some((n) =>
            [...n.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== ''),
          ),
        ).length,
        backgroundImages: lines.filter((l) => getComputedStyle(l).backgroundImage !== 'none')
          .length,
        hidden: lines.filter((l) => l.closest('[aria-hidden="true"]') !== null).length,
      };
    }, editor);
    expect(facts.canvases).toBe(0);
    expect(facts.lines).toBeGreaterThan(0);
    expect(facts.withTextNode).toBeGreaterThan(0);
    expect(facts.backgroundImages).toBe(0);
    expect(facts.hidden).toBe(0);

    const { text } = await longestLine(page);
    const word = text
      .trim()
      .split(/\s+/)
      .find((w) => /^[A-Za-z]{5,}$/.test(w));
    expect(word, `a word in "${text}"`).toBeDefined();
    // Searchable: a text locator finds the painted word in the shadow root.
    await expect(
      page.locator(`${editor} .de-page-view .de-line`, { hasText: word! }).first(),
    ).toBeVisible();
    // The accessibility tree carries the painted text.
    const snapshot = await page.locator(`${editor} .de-page-view`).ariaSnapshot();
    expect(snapshot).toContain(word!);
  });

  test('a line stays at the same size and gets sharper at three times the device pixel ratio', async ({
    browser,
  }, info) => {
    const results: { dpr: number; width: number; ink: number; share: number }[] = [];
    for (const dpr of [1, 3]) {
      const context = await browser.newContext({
        deviceScaleFactor: dpr,
        viewport: { width: 1100, height: 800 },
      });
      const page = await context.newPage();
      try {
        await openPageView(page);
        const line = await longestLine(page);
        const stats = await halftoneShare(page, line.png);
        results.push({ dpr, width: line.width, ...stats });
      } finally {
        await context.close();
      }
    }
    info.annotations.push({ type: 'sharpness', description: JSON.stringify(results) });
    const [one, three] = results as [(typeof results)[number], (typeof results)[number]];
    // The same line is as wide in CSS pixels at both ratios.
    expect(Math.abs(one.width - three.width)).toBeLessThanOrEqual(1);
    // More device pixels carry the ink, and a smaller share of them are soft edges.
    expect(three.ink).toBeGreaterThan(one.ink * 3);
    expect(three.share, JSON.stringify(results)).toBeLessThan(one.share * 0.85);
  });
});
