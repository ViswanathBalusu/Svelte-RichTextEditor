// PRO-008 criterion 5 (05 §2; PRO-041; D66): a page on an allowed origin can read the discovery
// document, and a page on another origin cannot.
//
// The first part reads the CORS headers of `GET /.well-known/dep` over HTTP. The second part runs a
// real browser: Playwright's Chromium (installed for `pnpm test:browsers`) loads a page from a small
// server on this machine and fetches discovery from the document service, which is another origin
// (another port). It skips when Chromium is not installed.
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserType } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './support.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let chromium: BrowserType | null = null;
try {
  const pw = await import('playwright');
  chromium = existsSync(pw.chromium.executablePath()) ? pw.chromium : null;
} catch {
  chromium = null;
}

const MEMBERS = ['cdm', 'engines', 'features', 'jwks_uri', 'mode', 'rest', 'versions', 'ws'];

/** A server that answers every request with an empty page: an origin for a browser page. */
async function pageServer(host: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>host application</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, origin: `http://${host}:${(server.address() as AddressInfo).port}` };
}

const closeServer = (s: Server | undefined) =>
  new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));

describe('discovery under the CORS rules (PRO-008 criterion 5)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory');
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lets an allowed origin read discovery, without a token', async () => {
    const r = await h.call('GET', '/.well-known/dep', {
      headers: { Origin: 'https://app.example.test' },
    });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(MEMBERS);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(r.headers.get('vary') ?? '').toMatch(/origin/i);
  });

  it('gives an origin that no tenant allows no CORS grant', async () => {
    const r = await h.call('GET', '/.well-known/dep', {
      headers: { Origin: 'https://evil.example.test' },
    });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the preflight of an allowed origin and refuses that of another', async () => {
    const ok = await h.call('OPTIONS', '/.well-known/dep', {
      headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'GET' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const bad = await h.call('OPTIONS', '/.well-known/dep', {
      headers: { Origin: 'https://evil.example.test', 'Access-Control-Request-Method': 'GET' },
    });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe.skipIf(!chromium)('discovery fetched by a page in Chromium (PRO-008 criterion 5)', () => {
  let h: Harness;
  let browser: Browser;
  let allowed: { server: Server; origin: string };
  let other: { server: Server; origin: string };

  /** What a page sees when it fetches discovery: the document, or the name of the error. */
  const fetchFrom = async (origin: string, init?: { headers: Record<string, string> }) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      return await page.evaluate(
        async ([url, options]) => {
          try {
            const res = await fetch(url as string, options as RequestInit);
            return { ok: true, status: res.status, body: (await res.json()) as unknown };
          } catch (e) {
            return { ok: false, error: (e as Error).name };
          }
        },
        [`${h.base}/.well-known/dep`, init ?? {}] as const,
      );
    } finally {
      await page.close();
    }
  };

  beforeAll(async () => {
    h = await startHarness('memory');
    // Two pages on this machine. Both are other origins than the service (another port); only
    // the first is on the tenant's list.
    allowed = await pageServer('127.0.0.1');
    other = await pageServer('127.0.0.1');
    await h.parts.registry.addOrigin(h.tenant, allowed.origin);
    browser = await chromium!.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await closeServer(allowed?.server);
    await closeServer(other?.server);
    await h?.close();
  });

  it('is readable from a page on an allowed origin', async () => {
    expect(new URL(h.base).origin).not.toBe(allowed.origin);
    const r = await fetchFrom(allowed.origin);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body as object).sort()).toEqual(MEMBERS);
  });

  it('is readable after a preflight too (a request with a header that is not safelisted)', async () => {
    const r = await fetchFrom(allowed.origin, {
      headers: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
    });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.body as object).sort()).toEqual(MEMBERS);
  });

  it('is not readable from a page on an origin that is not allowed', async () => {
    const r = await fetchFrom(other.origin);
    expect(r).toEqual({ ok: false, error: 'TypeError' });
  });
});
