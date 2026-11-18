/**
 * UX-017 on the product element (lane w3): the recovered edits pane lists work that the server
 * refused, which the journal keeps. Ada types into the legal region, her grant is withdrawn and the
 * held commit is refused with `permission_denied` (the real Room of backend-mock). The pane lists the
 * items with their reason, copy and insert work (insert through the guards, refused where Ada may
 * not edit), discarding needs a second, deliberate step, and after the tab is closed and opened
 * again the items that were not discarded are listed and the discarded one is not. The set-up is
 * that of fe-010-recovered-reopen.spec.ts.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=58301 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-017-recovered-pane.spec.ts --workers=1`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const TYPED = ' Recovered after refusal.';
const EDITOR = 'doc-editor[data-test="ux017"]';

/** A UUID version 7 for this run: the document identifier every tab opens. */
function uuid7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

interface Harness {
  caretIn(id: string, at: 'start' | 'end'): void;
  nodeText(id: string): string | null;
  selection(): { from: number; to: number; parentType: string };
}

interface Embed {
  service: {
    createDocument(content: unknown, opts: { id: string; grants: unknown[] }): string;
    backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
    setGrants(docId: string, grants: unknown[]): void;
  };
  docId: string;
  SPIKE_IDS: { region: string; legal: string; title: string; last: string };
  harness(el: Element): Promise<Harness>;
  internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
}

type Which = 'legal' | 'last';

/** The text of a paragraph of the spike document, read through the editor's harness. */
function nodeText(page: Page, which: Which): Promise<string | null> {
  return page.evaluate(
    async ({ which, sel }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      const h = await e.harness(document.querySelector(sel)!);
      return h.nodeText(e.SPIKE_IDS[which]);
    },
    { which, sel: EDITOR },
  );
}

/** Puts the caret at the end of a paragraph through the editor's own selection. */
function caretIn(page: Page, which: Which): Promise<void> {
  return page.evaluate(
    async ({ which, sel }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      const h = await e.harness(document.querySelector(sel)!);
      h.caretIn(e.SPIKE_IDS[which], 'end');
    },
    { which, sel: EDITOR },
  );
}

/**
 * Puts the caret at the end of the legal-region paragraph and waits until the editor holds that
 * selection and has focus (a click is not reliable here: fe-010-recovered-reopen.spec.ts, round 4).
 */
async function caretAtEndOfLegal(page: Page): Promise<void> {
  await caretIn(page, 'legal');
  await expect
    .poll(
      () =>
        page.evaluate(async (sel) => {
          const el = document.querySelector(sel)!;
          const e = (window as unknown as { __embed: Embed }).__embed;
          const s = (await e.harness(el)).selection();
          const own = (
            el.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null }
          ).getSelection?.();
          const node = own?.anchorNode ?? document.getSelection()?.anchorNode ?? null;
          const host = node instanceof Element ? node : (node?.parentElement ?? null);
          return {
            empty: s.from === s.to,
            focused: !!el.shadowRoot!.activeElement?.closest('.de-editing-surface, .ProseMirror'),
            paragraph: host?.closest('p')?.textContent?.slice(0, 20) ?? null,
          };
        }, EDITOR),
      { message: 'the caret is not at the end of the legal-region paragraph', timeout: 10_000 },
    )
    .toMatchObject({ empty: true, focused: true });
}

/**
 * Creates the spike document under `docId` in this page's service and mounts an editor for Ada on
 * it. Her commits wait at the channel until `window.__ux017Release()` is called.
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
      __ux017Release: () => void;
      __ux017Recovered: Array<{ count: number }>;
    };
    const gate = new Promise<void>((resolve) => (w.__ux017Release = resolve));
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
    w.__ux017Recovered = [];
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'ux017';
    el.addEventListener('de-recovered-edits', (ev) =>
      w.__ux017Recovered.push((ev as CustomEvent<{ count: number }>).detail),
    );
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
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

interface JournalRows {
  commits: number;
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

const pane = (page: Page) => page.locator(`${EDITOR} .de-pane[data-pane="recovered"]`);
const rows = (page: Page) => pane(page).locator('li[data-item]');

/** Opens the recovered edits pane through the editor's own `openPane`, as the pane's command does. */
async function openPane(page: Page): Promise<void> {
  const opened = await page.evaluate((sel) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    return e.internals(document.querySelector(sel)!).editor.openPane('recovered');
  }, EDITOR);
  expect(opened).toBe(true);
  await expect(pane(page)).toBeVisible();
}

/** Types into the legal region, then has the Room refuse it; resolves with what the journal holds. */
async function makeRefused(page: Page, docId: string): Promise<JournalRows> {
  await caretAtEndOfLegal(page);
  await page.keyboard.type(TYPED);
  // The text is in the legal-region paragraph: otherwise nothing would be refused.
  expect(await nodeText(page, 'legal')).toMatch(
    /^Liability is limited.*Recovered after refusal\.$/,
  );
  await expect.poll(async () => (await readJournal(page, docId)).commits).toBeGreaterThan(0);
  await page.evaluate((docId) => {
    (window as unknown as { __embed: Embed }).__embed.service.setGrants(docId, []);
    (window as unknown as { __ux017Release: () => void }).__ux017Release();
  }, docId);
  const setAside = (j: JournalRows) => j.recovered.map((i) => i.text.replace(/\n/g, '')).join('');
  await expect
    .poll(async () => setAside(await readJournal(page, docId)), { timeout: 20_000 })
    .toBe(TYPED);
  return readJournal(page, docId);
}

test('UX-017 criteria 2 to 5: the pane lists refused work, inserts and copies it, discards on a second step, and keeps the rest after the tab is reopened', async ({
  page,
  context,
  browserName,
}) => {
  test.setTimeout(150_000);
  const docId = uuid7();
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openEmbed(page);
  await openDocument(page, docId);
  const journal = await makeRefused(page, docId);
  const total = journal.recovered.length;
  expect(total).toBeGreaterThan(0);

  // The pane lists every item with its reason; the event carried the count only.
  await openPane(page);
  await expect(rows(page)).toHaveCount(total);
  await expect(rows(page).first()).toHaveAttribute('data-reason', 'permission_denied');
  const counts = await page.evaluate(
    () => (window as unknown as { __ux017Recovered: Array<{ count: number }> }).__ux017Recovered,
  );
  expect(counts.at(-1)).toEqual({ count: total });
  expect(counts.every((c) => Object.keys(c).join() === 'count')).toBe(true);
  const first = rows(page).first();
  // Everything the item shows apart from its buttons: the reason, the parts refused, who changed the permission and the text.
  const detailOf = (page: Page) =>
    rows(page)
      .first()
      .evaluate((li) =>
        [...li.children]
          .filter((c) => !c.classList.contains('de-actions'))
          .map((c) => c.textContent?.trim())
          .join(' | '),
      );
  const detail = await detailOf(page);
  expect(detail.length).toBeGreaterThan(0);
  const firstText = await first.locator('[data-content]').innerText();
  expect(firstText.length).toBeGreaterThan(0);

  // Copy puts the item's text on the clipboard (Chromium lets the test read it back).
  if (browserName === 'chromium') {
    await first.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(firstText);
  }

  // Insert. The legal region is no longer Ada's: there it is refused and changes nothing.
  const legalBefore = await nodeText(page, 'legal');
  await caretIn(page, 'legal');
  // The button is marked unavailable there (aria-disabled), so the click is forced; it runs nothing.
  await expect(first.getByRole('button', { name: 'Insert at the cursor' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await first.getByRole('button', { name: 'Insert at the cursor' }).click({ force: true });
  expect(await nodeText(page, 'legal')).toBe(legalBefore);
  // In the body, which she may edit, the text goes in at the caret through the guards.
  await caretIn(page, 'last');
  const lastBefore = (await nodeText(page, 'last')) ?? '';
  await first.getByRole('button', { name: 'Insert at the cursor' }).click();
  await expect.poll(() => nodeText(page, 'last')).toBe(`${lastBefore}${firstText}`);
  // Nothing left the pane by itself.
  await expect(rows(page)).toHaveCount(total);

  // Discarding asks first; keeping it leaves the item where it was.
  await first.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Discard for good' })).toBeVisible();
  await first.getByRole('button', { name: 'Keep it' }).click();
  await expect(rows(page)).toHaveCount(total);
  expect((await readJournal(page, docId)).recovered.length).toBe(total);
  await page.close({ runBeforeUnload: false });

  // Opened again: every item is still listed, because none was discarded.
  const again = await context.newPage();
  await openEmbed(again);
  await openDocument(again, docId);
  await openPane(again);
  await expect(rows(again)).toHaveCount(total, { timeout: 20_000 });
  // The same details as before the tab was closed (criterion 2, the journal branch).
  await expect.poll(() => detailOf(again)).toBe(detail);

  // Discard one, with the second step. Close and open once more: it is gone, the rest stay.
  const row = rows(again).first();
  await row.getByRole('button', { name: 'Discard', exact: true }).click();
  await row.getByRole('button', { name: 'Discard for good' }).click();
  await expect(rows(again)).toHaveCount(total - 1);
  await expect.poll(async () => (await readJournal(again, docId)).recovered.length).toBe(total - 1);
  await again.close({ runBeforeUnload: false });

  const third = await context.newPage();
  await openEmbed(third);
  await openDocument(third, docId);
  await openPane(third);
  await expect(rows(third)).toHaveCount(total - 1, { timeout: 20_000 });
  await third.close();
});
