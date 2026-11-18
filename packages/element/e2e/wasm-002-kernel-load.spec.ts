/**
 * WASM-002 (lane w6): the layout kernel loads on demand, from the library build, in the four
 * browsers. The page `pages/lib.html` loads the distributable by URL, as a host does.
 *
 * - A session that only uses the web view fetches no `.wasm` file and compiles nothing.
 * - `view="print"` asks for the page view: the kernel's file is fetched from the directory of the
 *   component's own chunks (an `assets/` sibling of `chunks/`), compiled while it streams when the
 *   server says `application/wasm`, and `de-diagnostic` reports it with its time.
 * - With the same file served as `application/octet-stream`, it is read whole and compiled with
 *   `WebAssembly.compile`, and the event says `streaming: false`.
 * - The file is a file: no chunk of the library holds it as base64.
 *
 * Run with `DOCEDIT_DEMO_PORT=4796 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/wasm-002-kernel-load.spec.ts`.
 * It needs the kernel build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { type Page, expect, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';

interface Diagnostic {
  feature: string;
  kind: string;
  ms: number | null;
  streaming: boolean | null;
  code: string | null;
  directive: string | null;
}

async function mount(page: Page, view: string | null): Promise<void> {
  await openLib(page);
  await page.evaluate(() =>
    (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib.load(),
  );
  await page.evaluate(async (viewAttribute) => {
    const lib = (window as unknown as { __lib: { docId: string; backend(sub: string): unknown } })
      .__lib;
    const w = window as unknown as { __diagnostics: Diagnostic[]; __compiled: string[] };
    w.__diagnostics = [];
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'kernel';
    el.addEventListener('de-diagnostic', (e) =>
      w.__diagnostics.push((e as CustomEvent<Diagnostic>).detail),
    );
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = lib.backend('ada');
    if (viewAttribute !== null) el.setAttribute('view', viewAttribute);
    el.setAttribute('doc-id', lib.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, view);
}

const diagnostics = (page: Page): Promise<Diagnostic[]> =>
  page.evaluate(() => (window as unknown as { __diagnostics: Diagnostic[] }).__diagnostics);

/**
 * Counts the layout workers the page creates (WASM-004: the module is fetched, compiled and started
 * inside the worker, so the page's own `WebAssembly` is not where to look).
 */
async function countWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __workers: number; __pageCompiles: number };
    w.__workers = 0;
    w.__pageCompiles = 0;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        w.__workers++;
      }
    };
    // The page thread itself compiles nothing, in any entry point.
    for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']) {
      const original = (WebAssembly as unknown as Record<string, (...a: unknown[]) => unknown>)[
        name
      ];
      if (!original) continue;
      (WebAssembly as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        w.__pageCompiles++;
        return original.apply(WebAssembly, args);
      };
    }
  });
}

const counts = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __workers: number; __pageCompiles: number };
    return { workers: w.__workers, pageCompiles: w.__pageCompiles };
  });
test.describe('the layout kernel on demand (WASM-002)', () => {
  test('a session in the web view fetches and compiles no WebAssembly', async ({ page }) => {
    const wasm: string[] = [];
    page.on('request', (r) => {
      if (/\.wasm(\?|$)/.test(r.url())) wasm.push(r.url());
    });
    await countWorkers(page);
    await mount(page, null);
    await expect(page.locator('doc-editor[data-test="kernel"] .de-editing-surface')).toBeVisible();
    await page.waitForTimeout(500);
    expect(wasm).toEqual([]);
    expect(await counts(page)).toEqual({ workers: 0, pageCompiles: 0 });
    expect(await diagnostics(page)).toEqual([]);
  });

  test('the page view asks for the kernel: fetched next to the chunks and compiled while it streams', async ({
    page,
  }) => {
    const wasm: { url: string; type: string | undefined }[] = [];
    const scripts: Promise<string>[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.endsWith('.wasm'))
        wasm.push({ url: url.pathname, type: response.headers()['content-type'] });
      if (url.pathname.startsWith('/lib/') && url.pathname.endsWith('.js'))
        scripts.push(response.text().catch(() => ''));
    });
    await countWorkers(page);
    await mount(page, 'print');
    await expect.poll(async () => (await diagnostics(page)).length).toBe(1);
    const [report] = await diagnostics(page);
    expect(report).toMatchObject({
      feature: 'layout-kernel',
      kind: 'loaded',
      streaming: true,
      code: null,
    });
    expect(report!.ms).toBeGreaterThan(0);
    expect(wasm).toHaveLength(1);
    expect(wasm[0]!.url).toMatch(/^\/lib\/assets\/docedit_layout_kernel_bg-[\w-]+\.wasm$/);
    expect(wasm[0]!.type).toBe('application/wasm');
    // The page created one worker and compiled nothing itself; the report says it streamed.
    expect(await counts(page)).toEqual({ workers: 1, pageCompiles: 0 });
    // No script of the library holds a module as base64 (`\0asm` and the version, encoded).
    for (const body of await Promise.all(scripts)) expect(body).not.toContain('AGFzbQEAAAA');
  });

  test('a server that does not say application/wasm gets the buffered path', async ({ page }) => {
    await page.route(/\.wasm(\?|$)/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-type': 'application/octet-stream' },
      });
    });
    await countWorkers(page);
    await mount(page, 'print');
    await expect.poll(async () => (await diagnostics(page)).length).toBe(1);
    const [report] = await diagnostics(page);
    expect(report).toMatchObject({ kind: 'loaded', streaming: false, code: null });
    expect(await counts(page)).toEqual({ workers: 1, pageCompiles: 0 });
  });

  test('a missing file is a load failure the host hears of', async ({ page }) => {
    await page.route(/\.wasm(\?|$)/, (route) => route.fulfill({ status: 404, body: 'gone' }));
    await mount(page, 'print');
    // The loader's report, then the element's decision about the page view (WASM-003).
    await expect.poll(async () => (await diagnostics(page)).length).toBe(2);
    const [failed, degraded] = await diagnostics(page);
    expect(failed).toMatchObject({ kind: 'load-failed', code: 'fetch_failed', ms: null });
    expect(degraded).toMatchObject({ kind: 'degraded', code: 'fetch_failed' });
    // The editor itself is unaffected.
    await expect(page.locator('doc-editor[data-test="kernel"] .de-editing-surface')).toBeVisible();
  });
});
