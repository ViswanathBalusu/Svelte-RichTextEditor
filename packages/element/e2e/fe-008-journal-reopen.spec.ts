/**
 * FE-008 criterion 6 (lane U-FE-001-016, round 3 fix): the tab is killed between the journal write
 * and the send, the document is opened again, and the journal entry is still present.
 *
 * Ada types in `<doc-editor>` on the embed page (the element built from source, its default
 * IndexedDB journal, backend-mock in the page). The page's backend is wrapped so that the channel's
 * `submit` never reaches the service: the commit is written to the journal and the send never
 * happens. The test waits until the entry is in IndexedDB, checks that the service has not received
 * the change, and kills the tab: Chromium and Edge crash the renderer (`Page.crash` over CDP);
 * Firefox and WebKit, which offer no crash, close the page without `beforeunload`. A new tab in the
 * same browser context (same origin, same IndexedDB) loads the page again, opens the same document
 * identifier in a new `<doc-editor>`, and reads the journal: the entry is there, with the typed text
 * and the identifier it was journalled under. Resubmitting it is FE-009's, so it is only read here.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=56003 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-008-journal-reopen.spec.ts`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Journalled before the kill.';

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
 * document), and mounts an editor for Ada on it. With `blockSend`, the channel's `submit` never
 * reaches the service.
 */
async function openDocument(page: Page, docId: string, blockSend: boolean): Promise<void> {
  await page.evaluate(
    async ({ docId, blockSend }) => {
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
      if (blockSend) {
        const open = backend.sync.open.bind(backend.sync);
        backend.sync.open = async (id, opts) => {
          const channel = await open(id, opts);
          const w = window as unknown as { __fe008Sends: number };
          w.__fe008Sends = 0;
          // The tab dies before the commit goes out: the send never reaches the service.
          channel.submit = () => {
            w.__fe008Sends++;
            return new Promise(() => {});
          };
          return channel;
        };
      }
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'fe008';
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
      el.backend = backend;
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { docId, blockSend },
  );
  await expect(page.locator('doc-editor[data-test="fe008"] .de-editing-surface')).toBeVisible();
}

interface JournalRead {
  /** The journalled commits of the document, by identifier, with the text their steps insert. */
  commits: Array<{ id: string; text: string }>;
  /** The text the journalled queue of unsent steps inserts. */
  queue: string;
}

/**
 * What the journal holds for `docId`, read straight from IndexedDB (`docedit-journal`, the stores
 * of packages/element/src/journal-idb.ts). Called only once an editor has opened the database.
 */
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
            // The text the steps insert, in order: typing gives about one step per key.
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

/** Everything the journal holds for the document, as text: the commits, then the queue. */
const journalled = (j: JournalRead) => j.commits.map((c) => c.text).join('') + j.queue;

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

test('FE-008 criterion 6: a tab killed between the journal write and the send leaves the entry for the next open', async ({
  page,
  context,
  browserName,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await openDocument(page, docId, true);

  await page
    .locator('doc-editor[data-test="fe008"] .de-editing-surface p', { hasText: 'Last paragraph.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);

  // The first commit is written to the journal and its send is attempted only after that; the keys
  // typed while it is unanswered are journalled as the queue.
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe(TYPED);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __fe008Sends: number }).__fe008Sends))
    .toBeGreaterThan(0);
  const before = await readJournal(page, docId);
  expect(before.commits.length).toBeGreaterThan(0);
  expect(before.commits[0]!.text.length).toBeGreaterThan(0);
  // The send never reached the service: its document does not hold the text.
  const stored = await page.evaluate(async (docId) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    const reader = e.service.backend({ sub: 'olga', name: 'Olga' }, { [docId]: 'owner' }) as {
      connect(): Promise<void>;
      sync: { loadContent(id: string): Promise<{ seq: number; doc: unknown }> };
    };
    await reader.connect();
    const c = await reader.sync.loadContent(docId);
    return { seq: c.seq, text: JSON.stringify(c.doc) };
  }, docId);
  expect(stored.text).not.toContain('Journalled');

  const how = await killTab(page, browserName);
  test.info().annotations.push({ type: 'kill', description: how });

  // The document is opened again in a new tab of the same browser context.
  const again = await context.newPage();
  await openEmbed(again);
  await openDocument(again, docId, false);
  // Let the reopened editor settle; nothing it does on opening may remove the entry.
  await again.waitForTimeout(500);

  // The entry is still present after the kill, under the identifier it was journalled under, and
  // with the queue nothing typed is missing.
  const after = await readJournal(again, docId);
  expect(after.commits.length).toBeGreaterThan(0);
  expect(after.commits).toEqual(before.commits);
  expect(journalled(after)).toBe(TYPED);
  // The reopened editor shows the server's document: resubmitting the entry is FE-009's.
  const shown = await again.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="fe008"]')!;
    const e = (window as unknown as { __embed: Embed }).__embed;
    return (await e.harness(el)).nodeText(e.SPIKE_IDS.last);
  });
  expect(shown ?? '').not.toContain('Journalled');
});
