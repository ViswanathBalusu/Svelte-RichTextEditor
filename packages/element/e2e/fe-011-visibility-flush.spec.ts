/**
 * FE-011 criteria 1 and 3 (lane V-FE-001-016): the element flushes the journal when the page is
 * hidden, and work flushed that way survives a tab that is closed with no `pagehide` handler.
 *
 * Ada types into the spike document on the embed page (the element from source, its default
 * IndexedDB journal). Her commit is held at the channel, so it is unconfirmed. The page is hidden for
 * real: a second page of the same browser context is brought to the front, and the first page's
 * `document.visibilityState` reads `hidden`. The test records the `visibilitychange` events and the
 * IndexedDB transactions the page starts (an init script), so that the flush that the element runs
 * on `visibilitychange` can be told apart from the writes made while typing. The journal must hold
 * the unconfirmed work once the flush has run. The tab is then killed (Chromium and Edge: renderer
 * crash through CDP `Page.crash`; Firefox and WebKit: page closed without `beforeunload`), and a new
 * tab in the same browser context opens the same document and reads the journal back.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57001 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-011-visibility-flush.spec.ts`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Flushed while hidden.';

/** A UUID version 7 for this run: the document identifier both tabs open. */
function uuid7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

interface Embed {
  service: {
    createDocument(content: unknown, opts: { id: string; grants: unknown[] }): string;
    backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
  };
  docId: string;
  SPIKE_IDS: { region: string; last: string };
  harness(
    el: Element,
  ): Promise<{ caretIn(id: string, at: 'end'): void; nodeText(id: string): string | null }>;
}

/** Records, in the page, the visibility changes and the IndexedDB transactions it starts. */
const RECORD_INIT = () => {
  const log: Array<[string, number]> = [];
  (window as unknown as { __fe011: typeof log }).__fe011 = log;
  // Playwright keeps every page visible (a second page brought to the front leaves this one
  // `visible`), so the hidden state is simulated here: `visibilityState` and `hidden` read the flag,
  // and `__fe011Hide()` sets it and dispatches a real `visibilitychange` event on the document.
  let hiddenFlag = false;
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (hiddenFlag ? 'hidden' : 'visible'),
  });
  Object.defineProperty(Document.prototype, 'hidden', {
    configurable: true,
    get: () => hiddenFlag,
  });
  (window as unknown as { __fe011Hide: () => void }).__fe011Hide = () => {
    hiddenFlag = true;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  document.addEventListener('visibilitychange', () =>
    log.push([`visibilitychange:${document.visibilityState}`, performance.now()]),
  );
  const tx = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: unknown[]) {
    log.push([`tx:${String(args[0])}`, performance.now()]);
    return (tx as (...a: unknown[]) => IDBTransaction).apply(this, args);
  } as typeof tx;
};

/**
 * Creates the spike document under `docId` in this page's service (a copy of the page's own
 * document), and mounts an editor for Ada on it. The channel's `submit` never reaches the service,
 * so Ada's commit stays unconfirmed.
 */
async function openDocument(page: Page, docId: string): Promise<void> {
  await page.evaluate(
    async ({ docId }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      type Port = {
        connect(): Promise<void>;
        sync: {
          loadContent(id: string): Promise<{ cdm: number; requires: string[]; doc: unknown }>;
          open(id: string, opts: unknown): Promise<{ submit(c: unknown): Promise<unknown> }>;
        };
      };
      const reader = e.service.backend(
        { sub: 'olga', name: 'Olga' },
        { [e.docId]: 'owner' },
      ) as Port;
      await reader.connect();
      const source = await reader.sync.loadContent(e.docId);
      e.service.createDocument(
        { cdm: source.cdm, requires: source.requires, doc: source.doc },
        {
          id: docId,
          grants: [{ region: e.SPIKE_IDS.region, principal: 'user:ada', role: 'editor' }],
        },
      );
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [docId]: 'editor' }) as Port;
      const open = backend.sync.open.bind(backend.sync);
      backend.sync.open = async (id, opts) => {
        const channel = await open(id, opts);
        const w = window as unknown as { __fe011Sends: number };
        w.__fe011Sends = 0;
        channel.submit = () => {
          w.__fe011Sends++;
          return new Promise(() => {});
        };
        return channel;
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'fe011';
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = backend;
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { docId },
  );
  await expect(page.locator('doc-editor[data-test="fe011"] .de-editing-surface')).toBeVisible();
}

interface JournalRead {
  commits: Array<{ id: string; text: string }>;
  queue: string;
}

/** What the journal holds for `docId`, read straight from IndexedDB (`docedit-journal`). */
function readJournal(page: Page, docId: string): Promise<JournalRead> {
  return page.evaluate(
    (docId) =>
      new Promise<JournalRead>((resolve, reject) => {
        const open = indexedDB.open('docedit-journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
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
            const rows = commits.result as Array<{ docId: string; id: string; steps: unknown[] }>;
            resolve({
              commits: rows
                .filter((r) => r.docId === docId)
                .map((r) => ({ id: r.id, text: texts(r.steps) })),
              queue: texts((queue.result as { steps?: unknown } | undefined)?.steps ?? []),
            });
          };
        };
      }),
    docId,
  );
}

const journalled = (j: JournalRead) => j.commits.map((c) => c.text).join('') + j.queue;

/** Kills the tab: a renderer crash where the browser offers one, otherwise a close without unload. */
async function killTab(page: Page, browserName: string): Promise<string> {
  if (browserName === 'chromium' || browserName === 'msedge') {
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

test('FE-011: a page hidden with unconfirmed work keeps it in the journal and after a kill', async ({
  page,
  context,
  browserName,
}) => {
  const docId = uuid7();
  await page.addInitScript(RECORD_INIT);
  await openEmbed(page);
  await openDocument(page, docId);

  await page
    .locator('doc-editor[data-test="fe011"] .de-editing-surface p', { hasText: 'Last paragraph.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe(TYPED);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __fe011Sends: number }).__fe011Sends))
    .toBeGreaterThan(0);

  // The page is hidden (simulated, see RECORD_INIT) and the browser's event is dispatched.
  await page.evaluate(() => (window as unknown as { __fe011Hide: () => void }).__fe011Hide());
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
  await page.waitForTimeout(300);

  const log = await page.evaluate(
    () => (window as unknown as { __fe011: Array<[string, number]> }).__fe011,
  );
  const hiddenAt = log.find(([n]) => n === 'visibilitychange:hidden')?.[1];
  test.info().annotations.push({
    type: 'fe011-log',
    description: JSON.stringify(
      log.filter(([n]) => n.startsWith('visibilitychange') || n.startsWith('tx:')),
    ),
  });
  expect(hiddenAt, 'visibilitychange to hidden was dispatched in this page').toBeDefined();
  // The unconfirmed work is still in the journal once the page is hidden.
  expect(journalled(await readJournal(page, docId))).toBe(TYPED);

  // The tab is killed while hidden, with the work journalled.
  const how = await killTab(page, browserName);
  test.info().annotations.push({ type: 'kill', description: how });

  const again = await context.newPage();
  await openEmbed(again);
  await openDocument(again, docId);
  await again.waitForTimeout(300);
  const after = await readJournal(again, docId);
  expect(journalled(after)).toBe(TYPED);
});
