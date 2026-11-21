/**
 * UX-016 criterion 5 against the demo stack (lane w3, 2026-11-20): the author's tab is closed while
 * the save indicator reads "Not yet saved"; the author returns in a new tab; the journal's work is
 * sent to the document service again; and the indicator reads "Not yet saved", then "Saving", then
 * "Saved". It does not read "Saved" before the service has the work.
 *
 * Everything here is the product's: the published `<doc-editor>` bundle in the reference host's
 * editor page, its IndexedDB journal, the DEP client over a WebSocket, and the document service on
 * PostgreSQL, which outlives the tab. What the test controls is the network between the page and
 * the service, through `context.routeWebSocket`:
 *
 * - `refusing`: the page's `sync.submit` frames are dropped, so a commit is never stored and never
 *   acknowledged;
 * - `down`: every socket is closed and a new one is closed as soon as it opens, as when the network
 *   is gone;
 * - `slow`: a `sync.submit` frame reaches the service after a delay, so that "Saving" lasts longer
 *   than a frame on the return.
 *
 * The tab is killed, not navigated away: a renderer crash through CDP `Page.crash` in Chromium, and
 * a close without `beforeunload` in Firefox and WebKit, which offer no crash.
 *
 * What the indicator showed is recorded by a MutationObserver that an init script puts on the
 * shadow root of `<doc-editor>` at the moment the element creates it, so the list starts with the
 * first thing the indicator ever showed in that tab.
 *
 * Run against a stack that is already up (scripts/stack.ps1 up, with the lane's project name and
 * ports in stack/.env or the environment):
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/w3-ux-016-return.spec.ts
 *
 * The test creates its own document, titled with the lane's name, and types one marker into it.
 */
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { editor, eventsOf, openDocument, PEOPLE, recordEvents, serviceUrl } from './support.ts';

const RUN = Date.now().toString(36);
/** How long a `sync.submit` frame is held back on the return. */
const SLOW_MS = 800;

type Net = 'up' | 'refusing' | 'down' | 'slow';

interface Shown {
  t: number;
  shows: string;
}

declare global {
  interface Window {
    __ux016?: Shown[];
  }
}

/** Whether a frame the page sends is a `sync.submit` (05 §5.3): one JSON message per text frame. */
function isSubmit(frame: string | Buffer): boolean {
  if (typeof frame !== 'string') return false;
  try {
    return (JSON.parse(frame) as { t?: unknown }).t === 'sync.submit';
  } catch {
    return false;
  }
}

/** The network between the pages of `context` and the document service, as the test sets it. */
async function network(context: BrowserContext) {
  const servicePort = new URL(serviceUrl()).port;
  const state = { net: 'up' as Net, dropped: 0, forwarded: 0, sockets: 0 };
  const open = new Map<WebSocketRoute, WebSocketRoute>();
  await context.routeWebSocket(
    (url) => url.port === servicePort,
    (ws) => {
      state.sockets++;
      if (state.net === 'down') {
        void ws.close({ code: 1001, reason: 'the network is down' });
        return;
      }
      const server = ws.connectToServer();
      open.set(ws, server);
      ws.onMessage((frame) => {
        if (isSubmit(frame)) {
          if (state.net === 'refusing' || state.net === 'down') {
            state.dropped++;
            return;
          }
          state.forwarded++;
          if (state.net === 'slow') {
            setTimeout(() => server.send(frame), SLOW_MS);
            return;
          }
        }
        server.send(frame);
      });
      server.onMessage((frame) => ws.send(frame));
    },
  );
  return {
    state,
    /** The network goes: every open socket is closed on both sides, and new ones do not connect. */
    async down(): Promise<void> {
      state.net = 'down';
      for (const [ws, server] of open) {
        await ws.close({ code: 1001, reason: 'the network is down' }).catch(() => {});
        await server.close().catch(() => {});
      }
      open.clear();
    },
  };
}

/** Records what the status bar's indicator of `<doc-editor>` shows, from its first frame. */
async function recordIndicator(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const seen: Shown[] = [];
    window.__ux016 = seen;
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = attach.call(this, init);
      if (this.localName !== 'doc-editor') return root;
      const read = () => {
        const save = root.querySelector('.de-status .de-save');
        if (!save) return;
        const shows = [
          save.getAttribute('data-connection'),
          save.getAttribute('data-sync'),
          save.querySelector('[data-status="sync"]')?.textContent?.trim(),
          save.querySelector('[data-status="connection"]')?.textContent?.trim(),
        ].join('/');
        if (seen.at(-1)?.shows !== shows) seen.push({ t: performance.now(), shows });
      };
      new MutationObserver(read).observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-sync', 'data-connection'],
      });
      return root;
    };
  });
}

const shown = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window.__ux016 ?? []).map((s) => s.shows));

const indicator = (page: Page) => editor(page).locator('.de-status .de-save');

/**
 * The text the element's IndexedDB journal holds for `docId` (`docedit-journal`, commits and
 * queue; packages/element/src/journal-idb.ts), and how many commits.
 */
function journal(page: Page, docId: string): Promise<{ text: string; commits: number }> {
  return page.evaluate(
    (docId) =>
      new Promise<{ text: string; commits: number }>((resolve, reject) => {
        const open = indexedDB.open('docedit-journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('commits') || !db.objectStoreNames.contains('queues')) {
            db.close();
            resolve({ text: '', commits: 0 });
            return;
          }
          const t = db.transaction(['commits', 'queues'], 'readonly');
          const commits = t.objectStore('commits').getAll();
          const queue = t.objectStore('queues').get(docId);
          t.onerror = () => reject(t.error);
          t.oncomplete = () => {
            db.close();
            const texts = (steps: unknown) =>
              [...JSON.stringify(steps).matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)]
                .map((m) => m[1])
                .join('');
            const rows = (commits.result as Array<{ docId: string; steps: unknown[] }>).filter(
              (r) => r.docId === docId,
            );
            resolve({
              text:
                rows.map((r) => texts(r.steps)).join('') +
                texts((queue.result as { steps?: unknown } | undefined)?.steps ?? []),
              commits: rows.length,
            });
          };
        };
      }),
    docId,
  );
}

/** Kills the tab: a renderer crash where the browser offers one, otherwise a close without unload. */
async function killTab(page: Page, browserName: string): Promise<string> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const crashed = page.waitForEvent('crash');
    void cdp.send('Page.crash').catch(() => {});
    await crashed;
    await page.close().catch(() => {});
    return 'renderer crashed (CDP Page.crash)';
  }
  await page.close({ runBeforeUnload: false });
  return 'page closed without beforeunload';
}

const occurrences = (s: string, needle: string) => s.split(needle).length - 1;

test('a tab closed while the indicator reads not yet saved: on the return the journal sends the work again, and the indicator reads not yet saved, saving, saved (UX-016 criterion 5)', async ({
  browser,
  browserName,
}) => {
  const MARKER = `w3-UX-016 ${browserName} ${RUN}`;
  const context = await browser.newContext();
  await recordEvents(context);
  await recordIndicator(context);
  const net = await network(context);
  const page = await context.newPage();
  // A second person's browser, with no journal of the first and no routing: what the service holds.
  const witness = await browser.newContext();
  await recordEvents(witness);
  const witnessPage = await witness.newPage();
  let docId = '';
  const serviceHas = async (): Promise<number> => {
    await openDocument(witnessPage, PEOPLE.olivia, docId);
    await expect(editor(witnessPage).locator('p.de-p').first()).toBeVisible();
    return occurrences(
      (await editor(witnessPage).locator('p.de-p').first().textContent()) ?? '',
      MARKER,
    );
  };
  try {
    // The author creates a document and has it open, saved and online.
    await page.goto('/');
    await page.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
    await page.getByLabel('Title', { exact: true }).fill(`w3-UX-016 return ${browserName} ${RUN}`);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    docId = page.url().split('/').pop()!;
    await expect
      .poll(async () => (await eventsOf(page, 'de-ready')).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect(indicator(page)).toHaveAttribute('data-sync', 'saved');
    await expect(indicator(page)).toHaveAttribute('data-connection', 'online');
    // A first visit never showed anything but saved.
    expect((await shown(page)).every((s) => s.split('/')[1] === 'saved')).toBe(true);
    await witnessPage.goto('/');
    await witnessPage.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
    await expect(witnessPage).toHaveURL(new RegExp(`/as/${PEOPLE.olivia.sub}/?$`));

    // The author types; the service does not take the work (the submits never arrive).
    net.state.net = 'refusing';
    const first = editor(page).locator('p.de-p').first();
    await first.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${MARKER}`, { delay: 15 });
    await expect(first).toContainText(MARKER);
    await expect
      .poll(() => net.state.dropped, { message: 'the page submitted the typed work' })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await journal(page, docId)).text, { message: 'the work is journalled' })
      .toContain(MARKER);
    // Then the network goes: the work is only in the journal, and the indicator says so in words.
    await net.down();
    await expect(indicator(page)).toHaveAttribute('data-sync', 'unsaved');
    await expect(indicator(page).locator('[data-status="sync"]')).toHaveText('Not yet saved');
    await expect(indicator(page)).not.toHaveAttribute('data-connection', 'online');
    await expect(indicator(page).locator('[data-status="connection"]')).toHaveText(
      /^(Reconnecting|Offline)$/,
    );
    expect((await journal(page, docId)).commits).toBeGreaterThan(0);

    // The tab is closed while it reads "Not yet saved".
    const how = await killTab(page, browserName);
    test.info().annotations.push({ type: 'kill', description: how });
    // The service does not have the work.
    expect(await serviceHas(), 'the service did not store the work').toBe(0);

    // The network is back, and slow. The author returns in a new tab of the same browser.
    net.state.net = 'slow';
    const forwardedBefore = net.state.forwarded;
    const again = await context.newPage();
    expect((await journalAfterLoad(again, docId)).text, 'the journal kept the work').toContain(
      MARKER,
    );
    await openDocument(again, PEOPLE.olivia, docId);
    // The typed work is back in the editor, and the indicator ends at saved.
    await expect(editor(again).locator('p.de-p').first()).toContainText(MARKER, {
      timeout: 60_000,
    });
    await expect(indicator(again)).toHaveAttribute('data-sync', 'saved', { timeout: 60_000 });
    await expect(indicator(again)).toHaveAttribute('data-connection', 'online');
    const seen = await shown(again);
    test.info().annotations.push({ type: 'indicator', description: seen.join(' -> ') });
    expect(seen).toEqual([
      'offline/unsaved/Not yet saved/Offline',
      'online/saving/Saving/Online',
      'online/saved/Saved/Online',
    ]);
    // The journal's work was sent again, and "Saving" lasted as long as the service took.
    expect(net.state.forwarded - forwardedBefore, 'submits on the return').toBeGreaterThan(0);
    const times = await again.evaluate(() => window.__ux016 ?? []);
    const savingAt = times.find((s) => s.shows.startsWith('online/saving'))!.t;
    const savedAt = times.find((s) => s.shows.startsWith('online/saved'))!.t;
    expect(savedAt - savingAt).toBeGreaterThanOrEqual(SLOW_MS - 50);
    // What the host heard (`de-status`, criterion 3): saving, then saved, and nothing after.
    const heard = (await eventsOf(again, 'de-status')).map((e) => {
      const d = e.detail as { connection: string; sync: string };
      return `${d.connection}/${d.sync}`;
    });
    expect(heard).toContain('online/saving');
    expect(heard.at(-1)).toBe('online/saved');
    expect(heard.filter((h) => h.endsWith('/saved'))).toEqual(['online/saved']);
    await expect(again.getByTestId('host-status')).toHaveText('Editor: online, saved');
    // The journal is empty, and the service holds the work once.
    await expect.poll(async () => (await journal(again, docId)).text).toBe('');
    await expect.poll(async () => (await journal(again, docId)).commits).toBe(0);
    expect(await serviceHas(), 'the service stored the returned work once').toBe(1);
  } finally {
    await witness.close();
    await context.close();
  }
});

/** The journal as a new tab of the profile finds it, read on the host's start page before any editor opens. */
async function journalAfterLoad(page: Page, docId: string) {
  await page.goto('/');
  return journal(page, docId);
}
