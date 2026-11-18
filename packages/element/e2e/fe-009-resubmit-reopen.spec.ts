/**
 * FE-009 in a browser (lane V-FE-001-016, then lane w1): work that was not confirmed when a visit
 * ended is sent again on the next visit, through the element with its default IndexedDB journal and
 * backend-mock in the page.
 *
 * 1. Criterion 1: Ada types, and the channel's `submit` never reaches the service, so the commit is
 *    journalled and unconfirmed. The element is destroyed (the journal stays in IndexedDB) and a new
 *    element opens the same document on the same service with the real channel. The journal
 *    empties, and the typed text is in the service's document exactly once.
 * 2. Criterion 4: the same, but the first tab is killed (Chromium and Edge: renderer crash through
 *    CDP `Page.crash`; Firefox and WebKit: page closed without `beforeunload`) and the second tab
 *    has a service of its own, whose log has another incarnation. The server answers `reload`, the
 *    work is not sent, and it is kept as recovered edits.
 *
 * The embed's service is held by each page, so two tabs never share a log. A commit the server stored
 * before the kill (criterion 2) is covered at the engine level (packages/engine/test/fe-009-resubmit.test.ts).
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-009-resubmit-reopen.spec.ts --trace=off`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Resubmitted once.';

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

/**
 * Creates the spike document under `docId` in this page's service (a copy of the page's own
 * document), and mounts an editor for Ada on it. With `hold`, the channel's `submit` never reaches
 * the service, so Ada's commit stays unconfirmed.
 */
async function openDocument(
  page: Page,
  docId: string,
  hold: boolean,
  create = true,
): Promise<void> {
  await page.evaluate(
    async ({ docId, hold, create }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      type Port = {
        connect(): Promise<void>;
        sync: {
          loadContent(id: string): Promise<{ cdm: number; requires: string[]; doc: unknown }>;
          open(id: string, opts: unknown): Promise<{ submit(c: unknown): Promise<unknown> }>;
        };
      };
      if (create) {
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
      }
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [docId]: 'editor' }) as Port;
      if (hold) {
        const open = backend.sync.open.bind(backend.sync);
        backend.sync.open = async (id, opts) => {
          const channel = await open(id, opts);
          const w = window as unknown as { __fe009Sends: number };
          w.__fe009Sends = 0;
          channel.submit = () => {
            w.__fe009Sends++;
            return new Promise(() => {});
          };
          return channel;
        };
      }
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'fe009';
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
    { docId, hold, create },
  );
  await expect(page.locator('doc-editor[data-test="fe009"] .de-editing-surface')).toBeVisible();
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

/** The text the service stores for the document, read through a separate backend. */
function storedText(page: Page, docId: string): Promise<string> {
  return page.evaluate(async (docId) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    const reader = e.service.backend({ sub: 'olga', name: 'Olga' }, { [docId]: 'owner' }) as {
      connect(): Promise<void>;
      sync: { loadContent(id: string): Promise<{ doc: unknown }> };
    };
    await reader.connect();
    const c = await reader.sync.loadContent(docId);
    return [...JSON.stringify(c.doc).matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .join('');
  }, docId);
}

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

const occurrences = (s: string, needle: string) => s.split(needle).length - 1;

/** Types the text at the end of the last paragraph of the editor. */
async function typeAtEnd(page: Page): Promise<void> {
  await page
    .locator('doc-editor[data-test="fe009"] .de-editing-surface p', { hasText: 'Last paragraph.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);
}

interface Hooks {
  internals(el: Element): {
    editor: { core: { recovered: { get(): { count: number; items: Array<{ text: string }> } } } };
  };
}

test('FE-009 criterion 1: journalled work is resubmitted once when the document is opened again', async ({
  page,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await openDocument(page, docId, true);
  await typeAtEnd(page);
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe(TYPED);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __fe009Sends: number }).__fe009Sends))
    .toBeGreaterThan(0);
  expect((await readJournal(page, docId)).commits.length).toBeGreaterThan(0);
  expect(occurrences(await storedText(page, docId), TYPED)).toBe(0);

  // The visit ends: the element is destroyed, and the commit stays in IndexedDB.
  await page.evaluate(() => {
    const el = document.querySelector('doc-editor[data-test="fe009"]') as HTMLElement & {
      destroy(): void;
    };
    el.destroy();
    el.remove();
  });
  expect((await readJournal(page, docId)).commits.length).toBeGreaterThan(0);

  // The next visit: a new element on the same document and service, with the real channel.
  await openDocument(page, docId, false, false);
  // The typed text is back in the editor at once, and the journal empties when the commit is
  // acknowledged.
  await expect(page.locator('doc-editor[data-test="fe009"] .de-editing-surface')).toContainText(
    TYPED.trim(),
  );
  await expect.poll(async () => (await readJournal(page, docId)).commits.length).toBe(0);
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe('');
  // The service's document holds the typed text once, not zero or two times.
  await expect.poll(async () => occurrences(await storedText(page, docId), TYPED)).toBe(1);
});

test('FE-009 criterion 4: after a killed tab, a log of another incarnation sets the work aside', async ({
  page,
  context,
  browserName,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await openDocument(page, docId, true);
  await typeAtEnd(page);
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe(TYPED);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __fe009Sends: number }).__fe009Sends))
    .toBeGreaterThan(0);

  const how = await killTab(page, browserName);
  test.info().annotations.push({ type: 'kill', description: how });

  // The new tab has a service of its own: the same document identifier, another log.
  const again = await context.newPage();
  await openEmbed(again);
  await openDocument(again, docId, false);

  // The work is not sent: it is kept as recovered edits, and the journal's commit is gone.
  await expect
    .poll(() =>
      again.evaluate(() => {
        const e = (window as unknown as { __embed: Hooks }).__embed;
        const el = document.querySelector('doc-editor[data-test="fe009"]')!;
        return e
          .internals(el)
          .editor.core.recovered.get()
          .items.map((i) => i.text);
      }),
    )
    .toEqual([TYPED]);
  await expect.poll(async () => (await readJournal(again, docId)).commits.length).toBe(0);
  expect(occurrences(await storedText(again, docId), TYPED)).toBe(0);
});
