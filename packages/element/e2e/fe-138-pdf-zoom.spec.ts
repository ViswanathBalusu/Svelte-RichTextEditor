/**
 * FE-138 criterion 3 in the PDF panel: when the person zooms, the page is drawn again at the new
 * scale, not stretched, so it stays sharp. The check reads the page canvas in the sandboxed viewer
 * frame: its size in CSS pixels follows the zoom, and its backing store keeps one device pixel for
 * every device pixel it covers (the CSS size times the device pixel ratio), at 50 %, 100 % and
 * 200 %, on a screen with a ratio of 2.
 * Run: `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-138-pdf-zoom.spec.ts`.
 * The harness is that of pdf-viewer.spec.ts (FE-071).
 */
import { type Page, expect, test } from '@playwright/test';
import { FILTERED_BROWSERS, openEmbed } from './embed-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER = `http://localhost:${PORT}/lib/viewer/pdf-viewer.html`;
const RATIO = 2;

test.use({ deviceScaleFactor: RATIO });

async function openPanel(page: Page, how: 'url' | 'data'): Promise<void> {
  await openEmbed(page);
  await page.evaluate(async (viewer) => {
    const e = (window as unknown as { __embed: { backend(s: string): unknown; docId: string } })
      .__embed;
    const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
    el.dataset['test'] = 'one';
    el['config'] = { pdfViewerUrl: viewer };
    el['backend'] = e.backend('ada');
    el.setAttribute('doc-id', e.docId);
    const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
    document.getElementById('mount')!.append(el);
    await ready;
  }, VIEWER);
  await page.evaluate(
    async ({ how, port }) => {
      const e = (
        window as unknown as {
          __embed: { openPdf(el: Element, s: unknown): Promise<unknown> };
        }
      ).__embed;
      const el = document.querySelector('doc-editor[data-test="one"]')!;
      let source: unknown = {
        url: `http://127.0.0.1:${port}/exports/pages.pdf?sig=test-signature&pages=2`,
      };
      if (how === 'data') {
        const coded = new Uint8Array(
          await (await fetch('/exports/pages.xor?sig=test-signature&pages=2')).arrayBuffer(),
        );
        source = { data: coded.map((b) => b ^ 0x5a).buffer };
      }
      await e.openPdf(el, source);
    },
    { how, port: PORT },
  );
}

function frameOf(page: Page) {
  return page.frames().find((f) => f.url().startsWith(VIEWER))!;
}

/** The page canvas: its CSS size, its backing store, and the device pixel ratio of the frame. */
async function measure(page: Page) {
  return frameOf(page).evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.page')!;
    return {
      cssWidth: parseFloat(canvas.style.width),
      cssHeight: parseFloat(canvas.style.height),
      width: canvas.width,
      height: canvas.height,
      ratio: globalThis.devicePixelRatio,
    };
  });
}

test('FE-138: the PDF panel draws the page again at each zoom, one device pixel per device pixel', async ({
  page,
}, info) => {
  await openPanel(page, FILTERED_BROWSERS.has(info.project.name) ? 'data' : 'url');
  const frame = frameOf(page);
  const label = frame.locator('.zoom');
  await expect(label).toHaveText('100 %');

  const base = await measure(page);
  expect(base.ratio).toBe(RATIO);
  // At 100 % the backing store covers every device pixel.
  expect(base.width).toBe(Math.floor(base.cssWidth * RATIO));
  expect(base.height).toBe(Math.floor(base.cssHeight * RATIO));

  // 200 %: three steps in (125, 150, 200). The page doubles and is drawn at the new size.
  const zoomIn = frame.locator('button[data-action="zoom-in"]');
  for (const text of ['125 %', '150 %', '200 %']) {
    await zoomIn.click();
    await expect(label).toHaveText(text);
  }
  await expect.poll(async () => (await measure(page)).cssWidth).toBeCloseTo(base.cssWidth * 2, -1);
  const big = await measure(page);
  expect(big.cssHeight / base.cssHeight).toBeCloseTo(2, 1);
  expect(big.width).toBe(Math.floor(big.cssWidth * RATIO));
  expect(big.height).toBe(Math.floor(big.cssHeight * RATIO));
  // The backing store grew with the zoom: it was drawn again, not stretched.
  expect(big.width).toBeGreaterThan(base.width * 1.9);

  // 50 %: back out to the first step. The page halves, and is still one device pixel per pixel.
  const zoomOut = frame.locator('button[data-action="zoom-out"]');
  for (const text of ['150 %', '125 %', '100 %', '75 %', '50 %']) {
    await zoomOut.click();
    await expect(label).toHaveText(text);
  }
  await expect.poll(async () => (await measure(page)).cssWidth).toBeCloseTo(base.cssWidth / 2, -1);
  const small = await measure(page);
  expect(small.width).toBe(Math.floor(small.cssWidth * RATIO));
  expect(small.height).toBe(Math.floor(small.cssHeight * RATIO));
});
