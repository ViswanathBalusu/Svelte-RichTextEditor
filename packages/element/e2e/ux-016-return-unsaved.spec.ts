/**
 * UX-016 criterion 5 in a browser (lane w3, 2026-11-20): a visit ends while the save indicator
 * reads "Not yet saved"; when the author returns, the journal's work is sent again and the
 * indicator reads "Not yet saved", then "Saving", then "Saved". It never reads "Saved" before the
 * service has confirmed the work.
 *
 * The element is the product's, with its default IndexedDB journal, its shell and its status bar.
 * The service is backend-mock in the page (the embed page, demo/embed-page.ts), so it lives as long
 * as the page does:
 *
 * 1. and 2. The visit ends by destroying the element; the page and its service stay. A new element
 *    opens the same document: the journal's commit (1) or its queue of steps that were never sent
 *    (2) is put back and confirmed. The service's answer on the return is held back for a moment,
 *    as a slow connection would, so that "Saving" lasts longer than a frame.
 * 3. A first visit, with nothing in the journal, reads "Saved" from its first frame.
 * 4. The tab is killed while the indicator reads "Not yet saved" (Chromium and Edge: a renderer
 *    crash through CDP `Page.crash`; Firefox and WebKit: the page is closed without `beforeunload`).
 *    A new tab of the same profile has a service of its own, so the work cannot be sent there: the
 *    indicator starts at "Not yet saved" and the work ends in the recovered edits, not lost.
 *
 * A tab that is closed and a service that outlives it, together, is the reference host's run
 * (apps/reference-host/e2e/w3-ux-016-return.spec.ts).
 *
 * What the indicator showed is recorded by a MutationObserver on the element's shadow root, set
 * before the element is put in the page, so the list starts with the first thing it ever showed.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts ux-016-return-unsaved`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Kept across the visit.';
const NAME = 'ux016';
const EDITOR = `doc-editor[data-test="${NAME}"]`;

/** A UUID version 7 for this run: the document identifier both visits open. */
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
  SPIKE_IDS: { region: string };
  internals(el: Element): {
    editor: { core: { recovered: { get(): { count: number; items: Array<{ text: string }> } } } };
  };
}

/** What a visit records in its page (`window.__ux016`). */
interface Visit {
  /** Commits handed to the channel. */
  sends: number;
  /** `performance.now()` when the service acknowledged a commit, in order. */
  acks: number[];
  /** What the status bar's indicator showed, from its first frame, without repeats. */
  seen: Array<{ t: number; shows: string }>;
  /** Every `de-status` the host heard, as `connection/sync`. */
  status: Array<{ t: number; detail: string }>;
  /** The connection drops: the channel reports `resuming`, as a lost socket does. */
  drop(): void;
}

type Channel = 'hold' | 'pass' | { delayMs: number };

/**
 * Mounts an editor for Ada on `docId`, creating the document first when asked (a copy of the embed
 * page's document). `channel` says what happens to a commit: it never reaches the service (`hold`),
 * it reaches it (`pass`), or it reaches it after a delay.
 */
async function openDocument(
  page: Page,
  docId: string,
  channel: Channel,
  create: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ docId, channel, create, name }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      type Submit = (c: unknown) => Promise<unknown>;
      type Port = {
        connect(): Promise<void>;
        sync: {
          loadContent(id: string): Promise<{ cdm: number; requires: string[]; doc: unknown }>;
          open(
            id: string,
            opts: unknown,
          ): Promise<{ submit: Submit; delivery: { push(kind: 'state', value: unknown): void } }>;
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
      const visit: Visit = { sends: 0, acks: [], seen: [], status: [], drop: () => {} };
      (window as unknown as { __ux016: Visit }).__ux016 = visit;
      const backend = e.service.backend({ sub: 'ada', name: 'ada' }, { [docId]: 'editor' }) as Port;
      const open = backend.sync.open.bind(backend.sync);
      backend.sync.open = async (id, opts) => {
        const opened = await open(id, opts);
        const submit = opened.submit.bind(opened);
        visit.drop = () =>
          opened.delivery.push('state', { status: 'resuming', reason: 'the socket dropped' });
        opened.submit = async (commit) => {
          visit.sends++;
          if (channel === 'hold') return new Promise(() => {});
          if (channel !== 'pass') await new Promise((r) => setTimeout(r, channel.delayMs));
          const ack = await submit(commit);
          visit.acks.push(performance.now());
          return ack;
        };
        return opened;
      };

      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      // The indicator of the status bar, read after every change inside the shadow root. The
      // observer is set before the element is in the page, so nothing it shows is missed.
      const root = el.shadowRoot!;
      const read = () => {
        const save = root.querySelector('.de-status .de-save');
        if (!save) return;
        const shows = [
          save.getAttribute('data-connection'),
          save.getAttribute('data-sync'),
          save.querySelector('[data-status="sync"]')?.textContent?.trim(),
          save.querySelector('[data-status="connection"]')?.textContent?.trim(),
        ].join('/');
        if (visit.seen.at(-1)?.shows !== shows) visit.seen.push({ t: performance.now(), shows });
      };
      new MutationObserver(read).observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-sync', 'data-connection'],
      });
      el.addEventListener('de-status', (ev) => {
        const d = (ev as CustomEvent<{ connection: string; sync: string }>).detail;
        visit.status.push({ t: performance.now(), detail: `${d.connection}/${d.sync}` });
      });
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
    { docId, channel, create, name: NAME },
  );
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

/** What the visit in this page recorded so far (without its `drop` function). */
const recorded = (page: Page): Promise<Omit<Visit, 'drop'>> =>
  page.evaluate(() => {
    const v = (window as unknown as { __ux016: Visit }).__ux016;
    return { sends: v.sends, acks: v.acks, seen: v.seen, status: v.status };
  });

/** The connection of the visit in this page drops. */
const drop = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { __ux016: Visit }).__ux016.drop());

/** What the indicator showed so far in this visit, in order. */
const shown = async (page: Page): Promise<string[]> =>
  (await recorded(page)).seen.map((s) => s.shows);

interface JournalRead {
  commits: string[];
  queue: string;
}

/** The text the journal holds for `docId`, read straight from IndexedDB (`docedit-journal`). */
function readJournal(page: Page, docId: string): Promise<JournalRead> {
  return page.evaluate(
    (docId) =>
      new Promise<JournalRead>((resolve, reject) => {
        const open = indexedDB.open('docedit-journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('commits') || !db.objectStoreNames.contains('queues')) {
            db.close();
            resolve({ commits: [], queue: '' });
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
            const rows = commits.result as Array<{ docId: string; steps: unknown[] }>;
            resolve({
              commits: rows.filter((r) => r.docId === docId).map((r) => texts(r.steps)),
              queue: texts((queue.result as { steps?: unknown } | undefined)?.steps ?? []),
            });
          };
        };
      }),
    docId,
  );
}

const journalled = (j: JournalRead) => j.commits.join('') + j.queue;

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

const occurrences = (s: string, needle: string) => s.split(needle).length - 1;

/** Types the text at the end of the last paragraph of the editor. */
async function typeAtEnd(page: Page): Promise<void> {
  await page.locator(`${EDITOR} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);
}

/** The visit ends: the element is destroyed and taken out of the page; the journal stays. */
async function endVisit(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement & { destroy(): void };
    el.destroy();
    el.remove();
  }, EDITOR);
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

const indicator = (page: Page) => page.locator(`${EDITOR} .de-status .de-save`);

/** Both indicators of the shell, the header's and the status bar's, show the same thing. */
async function expectIndicatorsAgree(page: Page): Promise<void> {
  const all = await page
    .locator(`${EDITOR} .de-save`)
    .evaluateAll((nodes) =>
      nodes.map((n) => `${n.getAttribute('data-connection')}/${n.getAttribute('data-sync')}`),
    );
  expect(all.length).toBeGreaterThan(0);
  expect(new Set(all).size, all.join(' ')).toBe(1);
}

/** The first visit, up to the moment it reads "Not yet saved" with the typed work journalled. */
async function visitThatEndsUnsaved(
  page: Page,
  docId: string,
  how: 'sent, then the connection drops' | 'the connection drops, then typed',
): Promise<void> {
  if (how === 'sent, then the connection drops') {
    await openDocument(page, docId, 'hold', true);
    await typeAtEnd(page);
    await expect.poll(async () => journalled(await readJournal(page, docId))).toBe(TYPED);
    await expect.poll(async () => (await recorded(page)).sends).toBeGreaterThan(0);
    // Sent and not answered, with the connection up: the work is still being saved.
    await expect(indicator(page)).toHaveAttribute('data-sync', 'saving');
    await drop(page);
  } else {
    await openDocument(page, docId, 'pass', true);
    await drop(page);
    await expect(indicator(page)).toHaveAttribute('data-connection', 'reconnecting');
    await typeAtEnd(page);
    await expect.poll(async () => (await readJournal(page, docId)).queue).toBe(TYPED);
    expect((await recorded(page)).sends).toBe(0);
  }
  // In words, and with the connection beside it (criterion 2): never by colour alone.
  await expect(indicator(page).locator('[data-status="sync"]')).toHaveText('Not yet saved');
  await expect(indicator(page).locator('[data-status="connection"]')).toHaveText('Reconnecting');
  await expect(indicator(page)).toHaveAttribute('data-sync', 'unsaved');
  await expectIndicatorsAgree(page);
  expect(occurrences(await storedText(page, docId), TYPED)).toBe(0);
}

/** What a return that sends the work again must have shown, and what the host must have heard. */
async function expectReturnSaved(page: Page, docId: string): Promise<void> {
  // The typed text is back in the editor before anything is confirmed.
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toContainText(TYPED.trim());
  await expect(indicator(page)).toHaveAttribute('data-sync', 'saved');
  expect(await shown(page)).toEqual([
    'offline/unsaved/Not yet saved/Offline',
    'online/saving/Saving/Online',
    'online/saved/Saved/Online',
  ]);
  await expectIndicatorsAgree(page);
  const record = await recorded(page);
  // "Saved" was shown only after the service had acknowledged the work.
  const savedAt = record.seen.find((s) => s.shows.startsWith('online/saved'))!.t;
  expect(record.acks.length).toBeGreaterThan(0);
  expect(savedAt).toBeGreaterThanOrEqual(record.acks.at(-1)!);
  // `de-status` (criterion 3): the host heard saving and then saved, and saved only after the
  // acknowledgement.
  const heard = record.status.map((s) => s.detail);
  expect(heard).toContain('online/saving');
  expect(heard.at(-1)).toBe('online/saved');
  expect(heard.indexOf('online/saving')).toBeLessThan(heard.lastIndexOf('online/saved'));
  for (const s of record.status.filter((x) => x.detail.endsWith('/saved')))
    expect(s.t).toBeGreaterThanOrEqual(record.acks.at(-1)!);
  // The journal is empty, and the service holds the text once.
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe('');
  await expect.poll(async () => (await readJournal(page, docId)).commits.length).toBe(0);
  expect(occurrences(await storedText(page, docId), TYPED)).toBe(1);
}

test('UX-016 criterion 5: a commit left unsaved is sent again on the return, and the indicator reads not yet saved, saving, saved', async ({
  page,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await visitThatEndsUnsaved(page, docId, 'sent, then the connection drops');
  expect((await readJournal(page, docId)).commits.length).toBe(1);
  await endVisit(page);
  expect((await readJournal(page, docId)).commits.length).toBe(1);

  // The author returns. The service's answer takes a moment, as on a slow connection.
  await openDocument(page, docId, { delayMs: 700 }, false);
  await expectReturnSaved(page, docId);
  // The journal's commit under its own identifier, and behind it the keys that were typed after
  // that commit left, as one more commit when there were any.
  const { sends } = await recorded(page);
  expect(sends).toBeGreaterThanOrEqual(1);
  expect(sends).toBeLessThanOrEqual(2);
});

test('UX-016 criterion 5: work typed while the connection was down, and never sent, returns the same way', async ({
  page,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await visitThatEndsUnsaved(page, docId, 'the connection drops, then typed');
  expect((await readJournal(page, docId)).commits.length).toBe(0);
  await endVisit(page);
  expect((await readJournal(page, docId)).queue).toBe(TYPED);

  await openDocument(page, docId, { delayMs: 700 }, false);
  await expectReturnSaved(page, docId);
});

test('UX-016: a first visit, with nothing in the journal, reads saved from its first frame', async ({
  page,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await openDocument(page, docId, 'pass', true);
  // The views notify once per frame; a loaded machine may take a while to give the page one.
  await expect(indicator(page)).toHaveAttribute('data-connection', 'online', { timeout: 30_000 });
  expect(await shown(page)).toEqual(['offline/saved/Saved/Offline', 'online/saved/Saved/Online']);
});

test('UX-016 criterion 5: after a killed tab the new tab starts at not yet saved, and work it cannot send is kept as recovered edits', async ({
  page,
  context,
  browserName,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await visitThatEndsUnsaved(page, docId, 'sent, then the connection drops');
  const how = await killTab(page, browserName);
  test.info().annotations.push({ type: 'kill', description: how });

  // A new tab of the same profile: the journal is there, the page's service is another one.
  const again = await context.newPage();
  await openEmbed(again);
  expect((await readJournal(again, docId)).commits.length).toBe(1);
  await openDocument(again, docId, 'pass', true);
  await expect
    .poll(() =>
      again.evaluate((selector) => {
        const e = (window as unknown as { __embed: Embed }).__embed;
        const el = document.querySelector(selector)!;
        return e
          .internals(el)
          .editor.core.recovered.get()
          .items.map((i) => i.text);
      }, EDITOR),
    )
    .toEqual([TYPED]);
  await expect(indicator(again)).toHaveAttribute('data-sync', 'saved');
  const seen = await shown(again);
  // Never "Saved" while the work was only in the journal: the first thing shown says so.
  expect(seen[0]).toBe('offline/unsaved/Not yet saved/Offline');
  expect(seen.at(-1)).toBe('online/saved/Saved/Online');
  await expect.poll(async () => (await readJournal(again, docId)).commits.length).toBe(0);
  expect(occurrences(await storedText(again, docId), TYPED)).toBe(0);
});
