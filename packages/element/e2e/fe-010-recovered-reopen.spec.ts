/**
 * FE-010 criteria 1 and 4 (lane U-FE-001-016): work refused with `permission_denied` is written to the
 * journal as recovered edits, and it is still there when the tab is closed and opened again.
 *
 * Ada types into the legal region of the spike document (her grant is on that region). Her commit is
 * held at the channel, so that it is journalled but not sent. Her grant is then withdrawn with
 * `service.setGrants`, and the held commit is released: the real Room refuses it with
 * `permission_denied`, the engine sets the steps aside, and the session writes them to the
 * `recovered` store of `docedit-journal`. The tab is closed. A new tab in the same browser context
 * (same origin, same IndexedDB) opens the same document identifier, and the element raises
 * `de-recovered-edits` with the count the journal restored.
 *
 * The region the edits were meant for, and the pane that lists them, are not in this test (the pane
 * is UX's; the region is FE-010 criterion 6, still open).
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=56004 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-010-recovered-reopen.spec.ts`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Recovered after refusal.';

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
    setGrants(docId: string, grants: unknown[]): void;
  };
  docId: string;
  SPIKE_IDS: { region: string; legal: string; title: string; last: string };
  harness(el: Element): Promise<{
    caretIn(id: string, at: 'start' | 'end'): void;
    nodeText(id: string): string | null;
    selection(): { from: number; to: number; parentType: string };
  }>;
}

/**
 * Puts the caret at the end of the legal-region paragraph through the editor's own selection (the
 * harness's `caretIn`, which also focuses the view), then waits until the editor still holds that
 * selection and the browser's selection sits in the paragraph whose text starts "Liability is
 * limited". A click does not do this reliably: in Firefox under load the caret stayed where the
 * editor put it on opening (the heading), so the typed text landed outside Ada's grant and nothing
 * was refused (round 4 review).
 */
async function caretAtEndOfLegal(page: Page): Promise<void> {
  const expected = await page.evaluate(async () => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    const h = await e.harness(document.querySelector('doc-editor[data-test="fe010"]')!);
    h.caretIn(e.SPIKE_IDS.legal, 'end');
    return h.selection().from;
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const el = document.querySelector('doc-editor[data-test="fe010"]')!;
          const root = el.shadowRoot!;
          const e = (window as unknown as { __embed: Embed }).__embed;
          const s = (await e.harness(el)).selection();
          // The browser's selection, read the way each engine exposes a selection in a shadow root.
          const sel = document.getSelection();
          const nodes: Array<Node | null> = [];
          const composed = (
            sel as unknown as { getComposedRanges?: (...a: unknown[]) => StaticRange[] }
          )?.getComposedRanges;
          if (sel && typeof composed === 'function') {
            try {
              nodes.push(composed.call(sel, { shadowRoots: [root] })[0]?.startContainer ?? null);
            } catch {
              /* the older signature only */
            }
            try {
              nodes.push(composed.call(sel, root)[0]?.startContainer ?? null);
            } catch {
              /* the newer signature only */
            }
          }
          const own = (
            root as ShadowRoot & { getSelection?: () => Selection | null }
          ).getSelection?.();
          nodes.push(own?.anchorNode ?? null, sel?.anchorNode ?? null);
          const inRoot = nodes.find((n) => n && root.contains(n)) ?? null;
          const host = inRoot instanceof Element ? inRoot : (inRoot?.parentElement ?? null);
          return {
            stateFrom: s.from,
            stateEmpty: s.from === s.to,
            focused: !!root.activeElement?.closest('.de-editing-surface, .ProseMirror'),
            domParagraph: host?.closest('p')?.textContent?.slice(0, 20) ?? null,
          };
        }),
      { message: 'the caret is not at the end of the legal-region paragraph', timeout: 10_000 },
    )
    .toEqual({
      stateFrom: expected,
      stateEmpty: true,
      focused: true,
      domParagraph: 'Liability is limited',
    });
}

/**
 * Creates the spike document under `docId` in this page's service and mounts an editor for Ada on
 * it. Her commits wait at the channel until `window.__fe010Release()` is called. The element records
 * each `de-recovered-edits` detail in `window.__fe010Recovered`.
 */
async function openDocument(page: Page, docId: string): Promise<void> {
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
    const w = window as unknown as {
      __fe010Release: () => void;
      __fe010Recovered: Array<{ count: number }>;
    };
    const gate = new Promise<void>((resolve) => (w.__fe010Release = resolve));
    const open = backend.sync.open.bind(backend.sync);
    backend.sync.open = async (id, opts) => {
      const channel = await open(id, opts);
      const submit = channel.submit.bind(channel);
      channel.submit = async (c) => {
        await gate;
        return submit(c);
      };
      return channel;
    };
    w.__fe010Recovered = [];
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'fe010';
    el.addEventListener('de-recovered-edits', (ev) =>
      w.__fe010Recovered.push((ev as CustomEvent<{ count: number }>).detail),
    );
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
  }, docId);
  await expect(page.locator('doc-editor[data-test="fe010"] .de-editing-surface')).toBeVisible();
}

interface JournalRows {
  /** The journalled commits of the document. */
  commits: number;
  /** The recovered items the journal holds for the document. */
  recovered: Array<{ reason: string; text: string }>;
}

/** What `docedit-journal` holds for `docId`, read straight from IndexedDB. */
function readJournal(page: Page, docId: string): Promise<JournalRows> {
  return page.evaluate(
    (docId) =>
      new Promise<JournalRows>((resolve, reject) => {
        const open = indexedDB.open('docedit-journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const t = db.transaction(['commits', 'recovered'], 'readonly');
          const commits = t.objectStore('commits').getAll();
          const row = t.objectStore('recovered').get(docId);
          t.onerror = () => reject(t.error);
          t.oncomplete = () => {
            db.close();
            const rows = commits.result as Array<{ docId: string }>;
            const r = row.result as { items?: Array<{ reason: string; text: string }> } | undefined;
            resolve({
              commits: rows.filter((c) => c.docId === docId).length,
              recovered: r?.items ?? [],
            });
          };
        };
      }),
    docId,
  );
}

test('FE-010 criteria 1 and 4: refused work is kept as recovered edits and is there after the tab is opened again', async ({
  page,
  context,
}) => {
  const docId = uuid7();
  await openEmbed(page);
  await openDocument(page, docId);

  // Ada types into the legal region while her grant is still there. The commit is journalled and
  // waits at the channel.
  await caretAtEndOfLegal(page);
  await page.keyboard.type(TYPED);
  // The typed text is in the legal-region paragraph and nowhere else; otherwise the Room would
  // acknowledge it and the rest of the test would wait for a refusal that never comes.
  const placed = await page.evaluate(async () => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    const h = await e.harness(document.querySelector('doc-editor[data-test="fe010"]')!);
    return { legal: h.nodeText(e.SPIKE_IDS.legal), title: h.nodeText(e.SPIKE_IDS.title) };
  });
  expect(placed.legal, 'the typed text is not at the end of the legal-region paragraph').toMatch(
    new RegExp(`^Liability is limited.*${TYPED.replace(/[.]/g, '\\.')}$`),
  );
  expect(placed.title, 'the typed text landed in the heading').toBe('Scope');
  await expect.poll(async () => (await readJournal(page, docId)).commits).toBeGreaterThan(0);

  // The grant is withdrawn, then the held commit is sent: the Room refuses the region edit.
  await page.evaluate((docId) => {
    (window as unknown as { __embed: Embed }).__embed.service.setGrants(docId, []);
    (window as unknown as { __fe010Release: () => void }).__fe010Release();
  }, docId);
  // The engine's `text` puts a newline between the steps' characters; the typed text is what remains
  // without them. How the keys split into commits depends on timing: under load the held commit can
  // carry only the first key, and the keys typed after it go out in later commits once it is
  // answered, which the Room refuses in turn. The test therefore waits until everything typed is
  // set aside, not only the first item.
  const setAside = (j: JournalRows) => j.recovered.map((i) => i.text.replace(/\n/g, '')).join('');
  await expect
    .poll(async () => setAside(await readJournal(page, docId)), {
      message: 'the typed text is not all set aside as recovered edits',
      timeout: 20_000,
    })
    .toBe(TYPED);
  const before = await readJournal(page, docId);
  expect(before.recovered.length).toBeGreaterThan(0);
  expect(new Set(before.recovered.map((i) => i.reason))).toEqual(new Set(['permission_denied']));
  await page.close({ runBeforeUnload: false });

  // The tab is opened again on the same document: the journal restores the recovered edits.
  const again = await context.newPage();
  await openEmbed(again);
  await openDocument(again, docId);
  await expect
    .poll(
      () =>
        again.evaluate(
          () =>
            (window as unknown as { __fe010Recovered: Array<{ count: number }> }).__fe010Recovered,
        ),
      { timeout: 20_000 },
    )
    .toEqual(expect.arrayContaining([{ count: before.recovered.length }]));
  const after = await readJournal(again, docId);
  expect(after.recovered.length).toBe(before.recovered.length);
  await again.close();
});
