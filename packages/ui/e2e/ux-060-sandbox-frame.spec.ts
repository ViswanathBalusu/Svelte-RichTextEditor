/**
 * UX-060: a sandboxed extension in a real browser (criteria 1, 2, 3, 4 and the frame part of 5).
 * The page is a stand-in for the host (e2e/sandbox/host-page.ts): it keeps a token in
 * `localStorage`, a cookie and a global, and installs extensions through the real
 * `ExtensionHost` and `sandboxedExtension`. The extensions are scripts served here, one of them
 * hostile. The frame page is served with `default-src 'none'; script-src 'self'`, the host page
 * with `frame-src 'self'`, as the guide says. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-060-sandbox-frame.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = (p: string): string => join(here, '..', 'src', 'extensions', p);

/** An extension that tries to reach everything the host has, then uses what it is given. */
const HOSTILE = `
deExtension.activate(async (api) => {
  const out = {};
  const attempt = (name, fn) => {
    try { out[name] = 'reached:' + String(fn()); } catch (e) { out[name] = 'blocked:' + e.name; }
  };
  attempt('parentDocument', () => window.parent.document.title);
  attempt('parentToken', () => window.parent.hostToken);
  attempt('topLocation', () => window.top.location.href);
  attempt('localStorage', () => localStorage.getItem('token'));
  attempt('sessionStorage', () => sessionStorage.length);
  attempt('cookie', () => document.cookie);
  try { await indexedDB.databases(); out.indexedDB = 'reached'; } catch (e) { out.indexedDB = 'blocked:' + e.name; }
  out.origin = self.origin;
  try { out.popup = String(window.open('/secret.json')); } catch (e) { out.popup = 'null'; }
  try { await fetch('/secret.json'); out.fetch = 'reached'; } catch (e) { out.fetch = 'blocked:' + e.name; }
  try { window.top.location = '/pwned'; out.topNavigation = 'reached'; } catch (e) { out.topNavigation = 'blocked:' + e.name; }
  window.parent.postMessage({ v: 1, id: 1, method: 'replaceRange', args: [{ id: 'r', from: 0, to: 1 }, 'forged'] }, '*');
  out.text = await api.text(await api.range(1, 4));
  try { await api.replaceRange(await api.range(1, 4), 'hack'); out.write = 'allowed'; } catch (e) { out.write = 'refused:' + e.code; }
  document.body.dataset.result = JSON.stringify(out);
});
`;

/** An extension that edits: it may write, and nothing else is different. */
const EDITOR = `
deExtension.activate(async (api) => {
  const r = await api.range(2, 3);
  const res = await api.replaceRange(r, 'edited');
  document.body.dataset.result = JSON.stringify({ res });
});
`;

/** An extension that suggests only. */
const SUGGESTER = `
deExtension.activate(async (api) => {
  const r = await api.range(2, 3);
  let outcome;
  try { outcome = await api.replaceRange(r, 'suggested'); } catch (e) { outcome = { refused: e.code }; }
  document.body.dataset.result = JSON.stringify({ outcome });
  document.body.dataset.done = '1';
});
`;

/** Sends calls that do not match the schema; none may reach the document. */
const MALFORMED = `
deExtension.activate((api) => {
  api.range('a', 'b');
  api.replaceRange({ id: 'r', from: 0, to: 1 }, 42);
  api.text();
  window.parent.postMessage('hello', '*');
  api.text(null);
  document.body.dataset.done = '1';
});
`;

/** Renders two buttons, to see focus enter and leave the frame. */
const PANEL = `
deExtension.activate(() => {
  document.body.innerHTML = '';
  for (const id of ['b1', 'b2']) {
    const b = document.createElement('button');
    b.id = id;
    b.textContent = 'Button ' + id;
    document.body.append(b);
  }
  document.body.dataset.ready = '1';
});
`;

const SCRIPTS: Record<string, string> = {
  '/ext/hostile.js': HOSTILE,
  '/ext/editor.js': EDITOR,
  '/ext/suggester.js': SUGGESTER,
  '/ext/malformed.js': MALFORMED,
  '/ext/panel.js': PANEL,
};

let out = '';
let server: Server;
let origin = '';
let secretHits = 0;

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'ux060-'));
  const common = { configFile: false as const, logLevel: 'silent' as const };
  await build({
    ...common,
    build: {
      outDir: out,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      lib: {
        entry: join(here, 'sandbox', 'host-page.ts'),
        formats: ['iife'],
        name: 'hostPage',
        fileName: () => 'host-page.js',
      },
    },
  });
  await build({
    ...common,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: src('sandbox-runtime.ts'),
        formats: ['iife'],
        name: 'sandboxRuntime',
        fileName: () => 'sandbox-runtime.js',
      },
    },
  });
  const read = (name: string): Buffer => readFileSync(join(out, name));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (type: string, body: string | Buffer, csp?: string): void => {
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        ...(csp ? { 'content-security-policy': csp } : {}),
      });
      res.end(body);
    };
    if (path === '/')
      send(
        'text/html; charset=utf-8',
        '<!doctype html><meta charset="utf-8"><title>Host</title>' +
          '<button id="before">Before</button><div id="panel"></div><button id="after">After</button>' +
          '<script src="/host-page.js"></script>',
        "default-src 'none'; script-src 'self'; frame-src 'self'",
      );
    else if (path === '/sandbox-frame.html')
      send(
        'text/html; charset=utf-8',
        '<!doctype html><meta charset="utf-8"><title>Extension</title><script src="/sandbox-runtime.js"></script>',
        "sandbox allow-scripts; default-src 'none'; script-src 'self'",
      );
    else if (path === '/host-page.js' || path === '/sandbox-runtime.js')
      send('text/javascript; charset=utf-8', read(path.slice(1)));
    else if (SCRIPTS[path]) send('text/javascript; charset=utf-8', SCRIPTS[path]!);
    else if (path === '/secret.json') {
      secretHits += 1;
      send('application/json', '{"secret":true}');
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(out, { recursive: true, force: true });
});
test.beforeEach(() => {
  secretHits = 0;
});

type Win = {
  sandboxTest: {
    install(m: Array<Record<string, unknown>>): void;
    remove(): void;
    setSuggesting(v: boolean): void;
    calls: unknown[][];
    logs: Array<Record<string, unknown>>;
    reports: Array<Record<string, unknown>>;
    keys: Array<{ key: string; ctrl: boolean; shift: boolean; alt: boolean }>;
    pageKeys: string[];
    disposed(): number;
    frameCount(): number;
    sandboxAttribute(): string | null;
  };
};

async function open(page: Page): Promise<void> {
  await page.goto(origin + '/');
  await page.waitForFunction(() => 'sandboxTest' in window);
}
const manifest = (id: string, write: string, entry: string): Record<string, unknown> => ({
  id,
  name: `Extension ${id}`,
  apiVersion: '1',
  tier: 2,
  access: { read: 'view', write },
  entry: `${origin}${entry}`,
});
const install = (page: Page, ...m: Array<Record<string, unknown>>) =>
  page.evaluate((list) => (window as unknown as Win).sandboxTest.install(list), m);
const calls = (page: Page) => page.evaluate(() => (window as unknown as Win).sandboxTest.calls);
const logs = (page: Page) => page.evaluate(() => (window as unknown as Win).sandboxTest.logs);
const result = async (page: Page): Promise<Record<string, unknown>> => {
  const body = page.frameLocator('iframe').locator('body[data-result]');
  await expect(body).toHaveAttribute('data-result', /.+/);
  return JSON.parse((await body.getAttribute('data-result')) ?? '{}') as Record<string, unknown>;
};

test.describe('a sandboxed extension (UX-060)', () => {
  test('runs in a frame with no access to the host page, its storage or its token, and no network', async ({
    page,
  }) => {
    await open(page);
    await install(page, manifest('ext.hostile', 'none', '/ext/hostile.js'));
    const r = await result(page);
    // Every way to the host page, its storage and the top page is closed.
    expect(r['parentDocument']).toMatch(/^blocked:/);
    expect(r['parentToken']).toMatch(/^blocked:/);
    expect(r['topLocation']).toMatch(/^blocked:/);
    expect(r['localStorage']).toMatch(/^blocked:/);
    expect(r['sessionStorage']).toMatch(/^blocked:/);
    expect(r['cookie']).toMatch(/^blocked:/);
    expect(r['indexedDB']).toMatch(/^blocked:/);
    expect(r['topNavigation']).toMatch(/^blocked:/);
    expect(r['origin']).toBe('null');
    expect(r['popup']).toBe('null');
    // No network: the request was blocked by the frame's policy and never reached the server.
    expect(r['fetch']).toMatch(/^blocked:/);
    expect(secretHits).toBe(0);
    // The only way in is the message channel, and it works for what is allowed.
    expect(r['text']).toBe('host text');
    // The frame has exactly the one sandbox token; the host page is untouched.
    expect(
      await page.evaluate(() => (window as unknown as Win).sandboxTest.sandboxAttribute()),
    ).toBe('allow-scripts');
    expect(page.url()).toBe(origin + '/');
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('host-secret');
  });

  test('a call beyond the declared access is refused and logged, and the document is not touched', async ({
    page,
  }) => {
    await open(page);
    await install(page, manifest('ext.hostile', 'none', '/ext/hostile.js'));
    const r = await result(page);
    expect(r['write']).toBe('refused:access_denied');
    expect((await calls(page)).map((c) => c[0])).not.toContain('replaceRange');
    const refused = (await logs(page)).filter((l) => l['kind'] === 'refused');
    expect(refused).toEqual([
      expect.objectContaining({
        extension: 'ext.hostile',
        method: 'replaceRange',
        code: 'access_denied',
      }),
    ]);
  });

  test('an extension that may suggest is refused while the editor is not suggesting, and let through while it is', async ({
    page,
  }) => {
    await open(page);
    await install(page, manifest('ext.suggest', 'suggest', '/ext/suggester.js'));
    await expect(page.frameLocator('iframe').locator('body[data-done]')).toHaveAttribute(
      'data-done',
      '1',
    );
    expect((await result(page))['outcome']).toEqual({ refused: 'access_denied' });
    expect((await calls(page)).map((c) => c[0])).not.toContain('replaceRange');
    // The same extension again, with the editor in suggestion mode.
    await page.evaluate(() => {
      const t = (window as unknown as Win).sandboxTest;
      t.remove();
      t.setSuggesting(true);
    });
    await install(page, manifest('ext.suggest', 'suggest', '/ext/suggester.js'));
    await expect.poll(async () => (await calls(page)).map((c) => c[0])).toContain('replaceRange');
  });

  test('a write that is within access reaches the editor’s own document API, with the range and text it sent', async ({
    page,
  }) => {
    await open(page);
    await install(page, manifest('ext.editor', 'edit', '/ext/editor.js'));
    expect(await result(page)).toEqual({ res: { ok: true } });
    const replace = (await calls(page)).find((c) => c[0] === 'replaceRange');
    expect(replace).toEqual(['replaceRange', { id: 'r2-3', from: 2, to: 3 }, 'edited']);
    expect(await logs(page)).toEqual([]);
  });

  test('a message that does not match the schema, or comes from another source, is ignored', async ({
    page,
  }) => {
    await open(page);
    await install(page, manifest('ext.malformed', 'edit', '/ext/malformed.js'));
    await expect(page.frameLocator('iframe').locator('body[data-done]')).toHaveAttribute(
      'data-done',
      '1',
    );
    // Give the channel time to deliver what was sent; then nothing may have happened.
    await expect
      .poll(async () => (await logs(page)).filter((l) => l['kind'] === 'ignored').length)
      .toBeGreaterThanOrEqual(4);
    expect(await calls(page)).toEqual([]);
    // A window message from another source (here: the page itself, and a forged envelope) goes
    // nowhere: the host listens on the private channel only.
    await page.evaluate(() => {
      window.postMessage(
        { v: 1, id: 1, method: 'replaceRange', args: [{ id: 'r', from: 0, to: 1 }, 'x'] },
        '*',
      );
    });
    await page.waitForTimeout(200);
    expect(await calls(page)).toEqual([]);
  });

  test('removing the extension removes its frame and ends its API', async ({ page }) => {
    await open(page);
    await install(page, manifest('ext.editor', 'edit', '/ext/editor.js'));
    await result(page);
    expect(await page.evaluate(() => (window as unknown as Win).sandboxTest.frameCount())).toBe(1);
    await page.evaluate(() => (window as unknown as Win).sandboxTest.remove());
    expect(await page.evaluate(() => (window as unknown as Win).sandboxTest.frameCount())).toBe(0);
    expect(await page.evaluate(() => (window as unknown as Win).sandboxTest.disposed())).toBe(1);
  });

  test('an entry without access, or with an unknown level, is reported and no frame is made', async ({
    page,
  }) => {
    await open(page);
    const noAccess = manifest('ext.none', 'none', '/ext/editor.js');
    delete noAccess['access'];
    await install(page, noAccess, manifest('ext.bad-level', 'root', '/ext/editor.js'), {
      ...manifest('ext.tier1', 'none', '/ext/editor.js'),
      tier: 1,
    });
    const reports = await page.evaluate(() => (window as unknown as Win).sandboxTest.reports);
    expect(reports.map((r) => [r['extension'], r['reason']])).toEqual([
      ['ext.none', 'activation-failed'],
      ['ext.bad-level', 'activation-failed'],
      ['ext.tier1', 'activation-failed'],
    ]);
    expect(await page.evaluate(() => (window as unknown as Win).sandboxTest.frameCount())).toBe(0);
  });

  test('focus moves into and out of the frame, and the landmark keys reach the host', async ({
    page,
  }) => {
    await open(page);
    await install(page, manifest('ext.panel', 'none', '/ext/panel.js'));
    await expect(page.frameLocator('iframe').locator('body[data-ready]')).toHaveAttribute(
      'data-ready',
      '1',
    );
    const hostFocus = () =>
      page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    const frameFocus = () =>
      page
        .frameLocator('iframe')
        .locator('body')
        .evaluate(() => document.activeElement?.id);
    // Tab enters the frame, steps through its controls, and leaves it for the next control of the page.
    await page.locator('#before').focus();
    await page.keyboard.press('Tab');
    expect(await hostFocus()).toBe('IFRAME');
    expect(await frameFocus()).toBe('b1');
    await page.keyboard.press('Tab');
    expect(await frameFocus()).toBe('b2');
    await page.keyboard.press('Tab');
    expect(await hostFocus()).toBe('after');
    // Shift+Tab comes back in at the last control.
    await page.keyboard.press('Shift+Tab');
    expect(await hostFocus()).toBe('IFRAME');
    expect(await frameFocus()).toBe('b2');

    // Keys pressed in the frame never reach the page by themselves. The landmark keys and Escape
    // are sent to it; a letter is not.
    const keys = () => page.evaluate(() => (window as unknown as Win).sandboxTest.keys);
    const before = (await keys()).length;
    await page.keyboard.press('a');
    await page.keyboard.press('Control+F6');
    await page.keyboard.press('Shift+Control+F6');
    await page.keyboard.press('Alt+F6');
    await page.keyboard.press('Escape');
    await expect
      .poll(async () =>
        (await keys()).slice(before).map((k) => `${k.key}:${k.ctrl}:${k.shift}:${k.alt}`),
      )
      .toEqual([
        'F6:true:false:false',
        'F6:true:true:false',
        'F6:false:false:true',
        'Escape:false:false:false',
      ]);
    // None of them, and not the letter, reached the page as a key event of its own.
    expect(
      (await page.evaluate(() => (window as unknown as Win).sandboxTest.pageKeys)).filter(
        (k) => k === 'a' || k === 'F6' || k === 'Escape',
      ),
    ).toEqual([]);
  });
});
