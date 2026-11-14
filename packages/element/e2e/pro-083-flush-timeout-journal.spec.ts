/**
 * PRO-083 criterion 2 (lane V-PRO-069-085): unconfirmed commits that are not confirmed within
 * `timeoutMs` make `flush` reject with the number of unconfirmed commits, and the work stays in the
 * journal (FE-008, FE-009).
 *
 * Ada types in `<doc-editor>` on the embed page with its default IndexedDB journal. The page's
 * backend channel is wrapped so that `submit` never reaches the service and never answers, so the
 * commit stays unconfirmed. `flush({ timeoutMs })` must reject, with a `count` of at least one, and
 * the typed text must still be in the `docedit-journal` IndexedDB store afterwards.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-083-flush-timeout-journal.spec.ts`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Unconfirmed at the timeout.';

/** A UUID version 7 for this run: the document identifier the test opens. */
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
}

/** Creates the document under `docId` and mounts Ada's editor on it; the commits never get out. */
async function openStuckDocument(page: Page, docId: string): Promise<void> {
  await page.evaluate(async (docId) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    type Port = {
      connect(): Promise<void>;
      sync: {
        loadContent(id: string): Promise<{ cdm: number; requires: string[]; doc: unknown }>;
        open(id: string, opts: unknown): Promise<{ submit(c: unknown): Promise<unknown> }>;
      };
    };
    const reader = e.service.backend({ sub: 'olga', name: 'Olga' }, { [e.docId]: 'owner' }) as Port;
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
      // The commit is never confirmed: the send does not reach the service and never answers.
      channel.submit = () => new Promise(() => {});
      return channel;
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'pro083';
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
  }, docId);
  await expect(page.locator('doc-editor[data-test="pro083"] .de-editing-surface')).toBeVisible();
}

interface JournalRead {
  commits: Array<{ id: string; text: string }>;
  queue: string;
}

/** What the journal holds for `docId` in IndexedDB (`docedit-journal`, journal-idb.ts). */
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

test('PRO-083 criterion 2: flush rejects with the unconfirmed count at the timeout and the work stays journalled', async ({
  page,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await openStuckDocument(page, docId);

  await page
    .locator('doc-editor[data-test="pro083"] .de-editing-surface p', { hasText: 'Last paragraph.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);

  // The typed text reaches the journal before the flush is asked.
  await expect.poll(async () => journalled(await readJournal(page, docId))).toBe(TYPED);

  const outcome = await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="pro083"]') as HTMLElement & {
      flush(opts: { timeoutMs: number }): Promise<void>;
    };
    try {
      await el.flush({ timeoutMs: 1500 });
      return { resolved: true, count: null as number | null, message: '' };
    } catch (err) {
      const e = err as { count?: unknown; message?: unknown };
      return {
        resolved: false,
        count: typeof e.count === 'number' ? e.count : null,
        message: typeof e.message === 'string' ? e.message : String(err),
      };
    }
  });

  expect(outcome.resolved).toBe(false);
  expect(outcome.count).not.toBeNull();
  expect(outcome.count!).toBeGreaterThanOrEqual(1);
  test.info().annotations.push({ type: 'flush-rejection', description: outcome.message });

  // The rejected work is still in the journal (FE-008): nothing was dropped at the timeout.
  const after = await readJournal(page, docId);
  expect(journalled(after)).toBe(TYPED);
});
