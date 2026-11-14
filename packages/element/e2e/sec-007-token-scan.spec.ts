/**
 * SEC-007 criteria 1 to 3 (lane U-SEC-001-016): a full editing session in the element, with the
 * endpoint and `getToken` path (the DEP client's inputs; the transport is the demo's in-memory
 * service, see demo/embed-page.ts `useEndpoint`). Afterwards no issued token may appear in:
 * - the storage of the page (localStorage, sessionStorage, IndexedDB), its cookies and the page
 *   addresses the browser visited (the history of the session);
 * - any request address or request body, including WebSocket and asset addresses;
 * - the console output and any `de-*` event detail.
 * The scan covers the tokens issued during the session, as the form they take in `getToken`
 * (`token-<jti>`) and the bare identifier. Chromium, Edge, Firefox and WebKit (the config's projects).
 *
 * Limit: the transport is in memory, so the network half proves no token leaves through the
 * requests the page makes, not what a real DEP connection would send on its WebSocket hello frame
 * (that needs the wire service in a browser, not run here; see the story Notes).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

interface EmbedHooks {
  useEndpoint(): void;
  issueToken(sub: string, role?: string): string;
  events: unknown[];
}

const ENDPOINT = 'https://dep.example.test';

/** Mounts an element that reaches the service through the endpoint path, with `getToken`. */
async function mountWithEndpoint(page: Page, name: string): Promise<void> {
  await page.evaluate(
    async ({ name, endpoint }) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      e.useEndpoint();
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.dataset['test'] = name;
      el.setAttribute('endpoint', endpoint);
      el.setAttribute(
        'doc-id',
        (window as unknown as { __embed: { docId: string } }).__embed.docId,
      );
      const issued: string[] = [];
      (window as unknown as { __issued: string[] }).__issued = issued;
      el['getToken'] = async () => {
        const value = e.issueToken('ada', 'editor');
        issued.push(value);
        return value;
      };
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          {
            once: true,
          },
        );
      });
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { name, endpoint: ENDPOINT },
  );
  await expect(page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`)).toBeVisible();
}

/** The tokens the element asked for during the session. */
async function issuedTokens(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __issued: string[] }).__issued ?? []);
}

/** Every string the page holds in its storage, IndexedDB included, as one text. */
async function storageText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i) ?? '';
        parts.push(k, store.getItem(k) ?? '');
      }
    }
    parts.push(document.cookie);
    if (typeof indexedDB.databases === 'function') {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        parts.push(info.name);
        const db = await new Promise<IDBDatabase | null>((resolve) => {
          const r = indexedDB.open(info.name!);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
        });
        if (!db) continue;
        for (const s of Array.from(db.objectStoreNames)) {
          parts.push(s);
          const rows = await new Promise<unknown[]>((resolve) => {
            try {
              const req = db.transaction(s, 'readonly').objectStore(s).getAll();
              req.onsuccess = () => resolve(req.result as unknown[]);
              req.onerror = () => resolve([]);
            } catch {
              resolve([]);
            }
          });
          for (const row of rows) {
            if (typeof row === 'string') parts.push(row);
            else {
              try {
                parts.push(JSON.stringify(row) ?? '');
              } catch {
                parts.push(String(row));
              }
            }
          }
        }
        db.close();
      }
    }
    return parts.join('\n');
  });
}

test('SEC-007: a full session leaves no issued token in storage, cookies or history', async ({
  page,
}) => {
  await openEmbed(page);
  const visited: string[] = [page.url()];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) visited.push(f.url());
  });

  await mountWithEndpoint(page, 'sec-007-storage');
  const surface = page.locator('doc-editor[data-test="sec-007-storage"] .de-editing-surface');
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' sec007session');
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain('sec007session');
  await page.waitForTimeout(300);

  const tokens = await issuedTokens(page);
  expect(tokens.length, 'the session asked for a token').toBeGreaterThan(0);
  const stored = await storageText(page);
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('\n');
  for (const t of tokens) {
    const bare = t.replace(/^token-/, '');
    expect(stored, 'storage holds no token').not.toContain(t);
    expect(stored, 'storage holds no token identifier').not.toContain(bare);
    expect(cookies, 'cookies hold no token').not.toContain(t);
    for (const url of visited) expect(url, 'history holds no token').not.toContain(bare);
  }
});

test('SEC-007: no request address, body or console line carries a token', async ({ page }) => {
  await openEmbed(page);
  const seen: string[] = [];
  page.on('request', (r) => {
    seen.push(r.url());
    const body = r.postData();
    if (body) seen.push(body);
  });
  page.on('websocket', (ws) => seen.push(ws.url()));
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (err) => consoleLines.push(err.message));

  await mountWithEndpoint(page, 'sec-007-network');
  const surface = page.locator('doc-editor[data-test="sec-007-network"] .de-editing-surface');
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' sec007network');
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain('sec007network');
  await page.waitForTimeout(300);

  const tokens = await issuedTokens(page);
  expect(tokens.length, 'the session asked for a token').toBeGreaterThan(0);
  const events = await page.evaluate(() =>
    JSON.stringify((window as unknown as { __embed: EmbedHooks }).__embed.events),
  );
  for (const t of tokens) {
    const bare = t.replace(/^token-/, '');
    for (const s of seen) expect(s, 'request address or body holds no token').not.toContain(bare);
    for (const line of consoleLines) expect(line, 'console holds no token').not.toContain(bare);
    expect(events, 'de-* events hold no token').not.toContain(bare);
    expect(events, 'de-* events hold no token').not.toContain(t);
  }
});
