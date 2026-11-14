/**
 * FE-119 criterion 2 (lane U-FE-113-128): the JavaScript that the library build requests before the
 * editor reports `de-ready` does not include the PDF viewer, the math editor, the read view or the
 * panes. Those are lazy chunks (`chunks/<name>-<hash>.js`, see scripts/vite-configs.ts), loaded only
 * when the user asks for them.
 *
 * The page is the library build (pages/lib.html, demo/lib-page.ts), which a host loads with
 * `load()`. The document is the spike document of that page, not the 20-page document, so this proves
 * the request list for that document only; the 20-page figure and criteria 1, 3, 4 and 5 are open.
 * Every request made before `de-ready` is recorded; the test fails if one names a lazy feature.
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-119-critical-path.spec.ts`
 * (port from DOCEDIT_DEMO_PORT).
 */
import { expect, test } from '@playwright/test';

const LAZY = /viewer|pdf|math|pane|outline|read-view|print/i;

test('the editor is ready without the PDF viewer, math editor, read view or panes', async ({
  page,
}) => {
  const requested: string[] = [];
  let ready = false;
  await page.exposeFunction('__markReady', () => {
    ready = true;
  });
  page.on('request', (req) => {
    if (ready) return;
    const url = new URL(req.url());
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) requested.push(url.pathname);
  });

  await page.goto('/pages/lib.html');
  await page.waitForFunction(() => '__lib' in window);
  await page.evaluate(async () => {
    const lib = (
      window as unknown as {
        __lib: { backend(sub: string): unknown; docId: string; load(): Promise<unknown> };
      }
    ).__lib;
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.setAttribute('doc-id', lib.docId);
    el.backend = lib.backend('ada');
    el.addEventListener(
      'de-ready',
      () => (window as unknown as { __markReady(): void }).__markReady(),
      {
        once: true,
      },
    );
    document.getElementById('mount')!.append(el);
    await lib.load();
  });
  await expect.poll(() => ready, { timeout: 30_000 }).toBe(true);

  const lazy = requested.filter((path) => LAZY.test(path));
  test
    .info()
    .annotations.push({ type: 'requested-before-ready', description: requested.join(' | ') });
  expect(lazy).toEqual([]);
  expect(requested.some((path) => path.includes('/chunks/'))).toBe(true);
});
