/**
 * The PDF viewer in its sandboxed cross-origin frame (FE-071; 09 §9.3 rule 7; 10 §3.1), in every
 * browser. The host page is on 127.0.0.1, the viewer's page on localhost: another origin, served
 * with its own policy (demo/serve.ts). Exports are served with CORS headers, as signed URLs of
 * object storage are. On the spike machine a local filter answers Firefox and Edge with an empty
 * 204 for PDF bytes (spike S2 §2), so there the bytes are fetched XOR-encoded by the host page and
 * handed to the viewer as data; the signed-URL path runs in Chromium and WebKit.
 */
import { type Page, expect, test } from '@playwright/test';
import { EN } from '../src/strings.ts';
import { FILTERED_BROWSERS, openEmbed } from './embed-helpers.ts';
import { encodePolicy, runId } from './helpers.ts';
import { STRICT, collect, policy } from './s2-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER = `http://localhost:${PORT}/lib/viewer/pdf-viewer.html`;

/** Opens the embed page with the viewer configured, under `csp` when given. */
async function openWithViewer(
  page: Page,
  opts: { csp?: string; run?: string; viewer?: string } = {},
): Promise<void> {
  const query = opts.csp ? `?run=${opts.run}&csp=${encodePolicy(opts.csp)}` : '';
  await openEmbed(page, query);
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
  }, opts.viewer ?? VIEWER);
}

/** Opens an export in the viewer: by its signed URL, or as bytes where PDF responses are filtered. */
async function openPdf(
  page: Page,
  name: string,
  how: 'url' | 'data',
  query = '',
): Promise<{
  isolation: string;
  pages: number;
  worker: boolean;
  sandbox: string | null;
  src: string;
}> {
  return page.evaluate(
    async ({ name, how, query, port }) => {
      const e = (
        window as unknown as {
          __embed: {
            openPdf(
              el: Element,
              s: unknown,
            ): Promise<{
              frame: HTMLIFrameElement;
              isolation: string;
              pages: number;
              worker: boolean;
            }>;
          };
        }
      ).__embed;
      const el = document.querySelector('doc-editor[data-test="one"]')!;
      const signed = `http://127.0.0.1:${port}/exports/${name}.pdf?sig=test-signature${query}`;
      let source: unknown = { url: signed };
      if (how === 'data') {
        const coded = new Uint8Array(
          await (await fetch(`/exports/${name}.xor?sig=test-signature${query}`)).arrayBuffer(),
        );
        source = { data: coded.map((b) => b ^ 0x5a).buffer };
      }
      const r = await e.openPdf(el, source);
      return {
        isolation: r.isolation,
        pages: r.pages,
        worker: r.worker,
        sandbox: r.frame.getAttribute('sandbox'),
        src: r.frame.src,
      };
    },
    { name, how, query, port: PORT },
  );
}

const how = (project: string): 'url' | 'data' => (FILTERED_BROWSERS.has(project) ? 'data' : 'url');

function viewerFrame(page: Page) {
  return page.frames().find((f) => f.url().startsWith(VIEWER));
}

test.describe('FE-071 the PDF viewer', () => {
  test('draws the PDF from its signed URL in a sandboxed frame of another origin', async ({
    page,
  }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 §2); the data path runs below',
    );
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await openWithViewer(page);
    const r = await openPdf(page, 'sample', 'url');
    expect(r).toMatchObject({
      isolation: 'cross-origin',
      pages: 1,
      worker: true,
      sandbox: 'allow-scripts allow-same-origin',
    });
    // The frame fetched the export itself; the host page did not.
    const exportFetches = requested.filter((u) => u.includes('/exports/sample.pdf'));
    expect(exportFetches.length).toBeGreaterThan(0);
    const frame = viewerFrame(page)!;
    expect(new URL(frame.url()).origin).not.toBe(new URL(page.url()).origin);
    // The viewer's own policy allows no eval: only WebAssembly compilation.
    const response = await page.request.get(VIEWER);
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(
      await frame.evaluate(() => document.querySelector('canvas.page')!.getAttribute('aria-label')),
    ).toBe('Page 1 of 1');
  });

  test('draws the PDF from its bytes in every browser', async ({ page }) => {
    await openWithViewer(page);
    const r = await openPdf(page, 'sample', 'data');
    expect(r).toMatchObject({ isolation: 'cross-origin', pages: 1, worker: true });
  });

  test('a PDF with scripts, launch actions and form scripts runs nothing; the host is unaffected', async ({
    page,
    request,
  }, info) => {
    const dialogs: string[] = [];
    const popups: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    page.on('popup', (p) => popups.push(p.url()));
    await openWithViewer(page);
    await page.evaluate(() => {
      document.cookie = 'host-secret=1; path=/';
      localStorage.setItem('host-secret', '1');
    });
    const before = await page.evaluate(() => ({ title: document.title, href: location.href }));
    const r = await openPdf(page, 'scripts', how(info.project.name));
    expect(r.pages).toBe(1);
    // Interact with the page: click where the form field and the link are.
    const frame = viewerFrame(page)!;
    await frame.locator('canvas.page').click({ position: { x: 100, y: 85 } });
    await frame.locator('canvas.page').click({ position: { x: 100, y: 145 } });
    await page.waitForTimeout(500);
    const log = (await (await request.get(`/__log?since=0`)).json()) as Array<{ path: string }>;
    expect(log.filter((e) => e.path === '/pwned')).toEqual([]);
    expect([dialogs, popups]).toEqual([[], []]);
    expect(await page.evaluate(() => ({ title: document.title, href: location.href }))).toEqual(
      before,
    );
    // The frame reaches neither the host page's DOM nor its cookies or storage.
    const inside = await frame.evaluate(() => {
      let parentDom = 'blocked';
      try {
        parentDom = String(window.parent.document.title);
      } catch {
        // cross-origin
      }
      let storage: string;
      try {
        storage = localStorage.getItem('host-secret') ?? 'none';
      } catch {
        storage = 'blocked';
      }
      return { parentDom, cookie: document.cookie.includes('host-secret'), storage };
    });
    expect(inside).toEqual({ parentDom: 'blocked', cookie: false, storage: 'none' });
  });

  test('an extreme page count and a lying page tree keep the host responsive', async ({
    page,
  }, info) => {
    await openWithViewer(page);
    const many = await openPdf(page, 'pages', how(info.project.name), '&pages=10000');
    expect(many.pages).toBe(10000);
    const frame = viewerFrame(page)!;
    await frame.locator('main.pages').focus();
    await page.keyboard.press('End');
    await expect(frame.locator('.status')).toHaveText('Page 10000 of 10000');
    const started = Date.now();
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
    await page.evaluate(() => {
      const e = (
        window as unknown as { __embed: { viewers(el: Element): Array<{ destroy(): void }> } }
      ).__embed;
      for (const v of e.viewers(document.querySelector('doc-editor')!)) v.destroy();
    });
    // A page tree whose /Count claims a million pages: PDF.js counts the pages the tree holds, so
    // the viewer offers one, and paging past it changes nothing.
    const lying = await openPdf(page, 'lying', how(info.project.name));
    expect(lying.pages).toBe(1);
    const second = page.frames().find((f) => f.url().startsWith(VIEWER))!;
    await second.locator('main.pages').focus();
    await page.keyboard.press('PageDown');
    await expect(second.locator('.status')).toHaveText('Page 1 of 1');
    await expect(second.locator('.message')).toBeHidden();
    expect(await page.evaluate(() => document.title)).toBe('Embedding the editor');
  });

  test('page navigation and zoom by keyboard, visible focus, strings from the element', async ({
    page,
  }, info) => {
    await openWithViewer(page);
    await openPdf(page, 'pages', how(info.project.name), '&pages=3');
    const frame = viewerFrame(page)!;
    const next = frame.locator('button[data-action="next"]');
    await expect(next).toHaveText(EN.pdf.next);
    await expect(frame.locator('button[data-action="previous"]')).toHaveText(EN.pdf.previous);
    await expect(frame.locator('button[data-action="zoom-in"]')).toHaveText(EN.pdf.zoomIn);
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(frame.locator('.status')).toHaveText('Page 2 of 3');
    const outline = await next.evaluate((b) => getComputedStyle(b).outlineStyle);
    expect(outline).not.toBe('none');
    const zoomIn = frame.locator('button[data-action="zoom-in"]');
    await zoomIn.focus();
    await page.keyboard.press('Space');
    await expect(frame.locator('.zoom')).toHaveText('125 %');
    expect(await frame.evaluate(() => document.title)).toBe(EN.pdf.title);
    // The frame's page itself holds no interface text (strings come from src/strings.ts).
    const html = await (await page.request.get(VIEWER)).text();
    const body = html
      .slice(html.indexOf('<body>'), html.indexOf('</body>'))
      .replace(/<[^>]+>/g, '')
      .trim();
    expect(body).toBe('');
  });

  test('nothing of the viewer loads until it opens; destroying the editor ends the frame and its worker', async ({
    page,
  }) => {
    const requested: string[] = [];
    const workers: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    page.on('worker', (w) => workers.push(w.url()));
    await openWithViewer(page);
    expect(requested.filter((u) => /viewer|pdf/i.test(u))).toEqual([]);
    expect(workers).toEqual([]);
    await openPdf(page, 'sample', 'data');
    const frame = viewerFrame(page)!;
    const worker = page.workers().find((w) => w.url().includes('pdf.worker'));
    const closed = worker
      ? new Promise<boolean>((resolve) => worker.on('close', () => resolve(true)))
      : null;
    await page.evaluate(() =>
      (document.querySelector('doc-editor') as HTMLElement & { destroy(): void }).destroy(),
    );
    await expect.poll(() => frame.isDetached()).toBe(true);
    expect(
      await page.evaluate(() =>
        document.querySelector('doc-editor')!.shadowRoot!.querySelector('iframe'),
      ),
    ).toBeNull();
    if (closed)
      expect(
        await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 5000))]),
      ).toBe(true);
  });

  test('works under a strict host policy with Trusted Types, with frame-src for the viewer only', async ({
    page,
    request,
  }) => {
    const run = runId();
    const csp = policy(
      { 'frame-src': `http://localhost:${PORT}`, 'connect-src': "'self'" },
      STRICT,
    );
    await openWithViewer(page, { csp, run });
    const r = await openPdf(page, 'sample', 'data');
    expect(r.pages).toBe(1);
    const collected = await collect(page, request, run, 500);
    expect(collected.dom).toEqual([]);
    expect(collected.reports.filter((x) => x.source === 'page')).toEqual([]);
  });

  test('served from the host page’s own origin, the frame stays opaque and still draws', async ({
    page,
  }) => {
    await openWithViewer(page, { viewer: `/lib/viewer/pdf-viewer.html` });
    const r = await openPdf(page, 'sample', 'data');
    expect(r).toMatchObject({
      isolation: 'opaque',
      sandbox: 'allow-scripts',
      pages: 1,
      worker: false,
    });
  });
});
