/**
 * FE-107 in a real browser, through the element (02 §10): what the live regions of the shadow root
 * say about the save state, a refused edit, edits set aside for recovery and typing. Criteria 1, 2,
 * 4, 6 and 7 (criterion 3 is `fe-107-presence-live.spec.ts`; criterion 5 is `announcements.spec.ts`).
 *
 * Two regions speak in the root and both are `role="status"` (polite): the element's own region
 * (save state, collaborators) and the shell's (refused edits, edits set aside, mode, and so on).
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-107-live-regions.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface EmbedHooks {
  harness(el: Element): Promise<Record<string, (...a: unknown[]) => unknown>>;
  internals(el: Element): { root: ShadowRoot; liveRegion: HTMLElement; announcer: unknown };
  SPIKE_IDS: { intro: string; legal: string; after: string };
}

/** Calls a method of the spike harness of the editor on the page. */
function call<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ name, args }) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const h = await e.harness(document.querySelector('doc-editor[data-test="one"]')!);
      return h[name]!(...args) as T;
    },
    { name, args },
  );
}

/**
 * Records every text any `role="status"` region of the root shows, in order, on `window.__spoken`
 * (`own` is the element's region; `all` is every region in the root, the shell's too).
 */
function recordRegions(page: Page, target: string = editor): Promise<void> {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const { root, liveRegion } = e.internals(document.querySelector(sel)!);
    const spoken = { own: [] as string[], all: [] as string[] };
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    // The root changes for many reasons; a text counts once, when a region's text becomes it.
    let lastOwn = '';
    const lastRegion = new Map<Element, string>();
    new MutationObserver(() => {
      const own = liveRegion.textContent ?? '';
      if (own !== lastOwn && own !== '') spoken.own.push(own);
      lastOwn = own;
      for (const region of root.querySelectorAll('[role="status"]')) {
        const text = region.textContent ?? '';
        if (text !== '' && text !== lastRegion.get(region)) spoken.all.push(text);
        lastRegion.set(region, text);
      }
    }).observe(root, { childList: true, characterData: true, subtree: true });
  }, target);
}

const spoken = (page: Page): Promise<{ own: string[]; all: string[] }> =>
  page.evaluate(() => {
    const s = (window as unknown as { __spoken: { own: string[]; all: string[] } }).__spoken;
    return { own: [...s.own], all: [...s.all] };
  });

/** The text of every status region in the editor's shadow root, in one string. */
function statusText(page: Page, target: string = editor): Promise<string> {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const { root } = e.internals(document.querySelector(sel)!);
    return [...root.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '').join('|');
  }, target);
}

test.describe('FE-107 live regions of the shadow root', () => {
  test('criterion 1: a reader who may not change the document hears that it is read-only', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'vera', role: 'viewer' });
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const e = (window as unknown as { __embed: EmbedHooks }).__embed;
          return e.internals(document.querySelector(sel)!).liveRegion.textContent;
        }, editor),
      )
      .toBe('This document is read-only.');
  });

  test('criterion 2: an edit the guard refuses is announced as not applied, with the reason', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { sub: 'bob', name: 'one' });
    const ids = await page.evaluate(
      () => (window as unknown as { __embed: EmbedHooks }).__embed.SPIKE_IDS,
    );
    await recordRegions(page);
    // bob has no grant on the legal region: typing there is refused by the guard.
    await call(page, 'caretIn', ids.legal, 'end');
    await page.keyboard.type('x');
    await expect
      .poll(() => statusText(page))
      .toContain('That change was not made: you cannot change this part of the document.');
    // The sentence is said in a region of the same root as the text it describes, and names no scope.
    const inRoot = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const { root } = e.internals(document.querySelector(sel)!);
      const regions = [...root.querySelectorAll('[role="status"]')];
      const region = regions.find((r) =>
        (r.textContent ?? '').includes('That change was not made'),
      );
      return {
        sameRoot: region?.getRootNode() === root,
        surfaceInRoot: root.querySelector('.de-editing-surface') !== null,
        polite: region?.getAttribute('aria-live') ?? 'implied by role=status',
      };
    }, editor);
    expect(inRoot.sameRoot).toBe(true);
    expect(inRoot.surfaceInRoot).toBe(true);
    expect(await statusText(page)).not.toMatch(/rLegal|region:/);
    // The refused character is not announced.
    expect((await spoken(page)).all.join('|')).not.toMatch(/\bx\b/);
  });

  test('criterion 6: a host replacement string and the locale reach the announcement', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const notify = (notice: Record<string, unknown>) =>
      page.evaluate(
        ({ sel, notice }) => {
          const e = (window as unknown as { __embed: EmbedHooks }).__embed;
          const announcer = e.internals(document.querySelector(sel)!).announcer as {
            notify(n: Record<string, unknown>): boolean;
          };
          return announcer.notify(notice);
        },
        { sel: editor, notice },
      );
    await page.evaluate((sel) => {
      (document.querySelector(sel) as HTMLElement & { strings: unknown }).strings = {
        'announce.sync.unsaved': 'Not stored yet.',
      };
    }, editor);
    await recordRegions(page);
    // The sentence is the host's replacement, not the source text.
    await notify({ kind: 'sync', sync: 'unsaved' });
    await expect.poll(async () => (await spoken(page)).own).toEqual(['Not stored yet.']);

    // A pseudo-locale (UX-064) changes the words of a later sentence too.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement & { strings: unknown };
      el.strings = {};
      el.setAttribute('locale', 'en-XA');
    }, editor);
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const root = document.querySelector(sel)!.shadowRoot!;
          return root.querySelector('[role="toolbar"]')?.getAttribute('aria-label');
        }, editor),
      )
      // The accented table is loaded: the toolbar's name is no longer the source text.
      .not.toBe('Editing');
    await notify({ kind: 'recovered', count: 4 });
    await expect.poll(async () => (await spoken(page)).own.length).toBe(2);
    const accented = (await spoken(page)).own[1]!;
    expect(accented).not.toBe('Edits set aside for recovery: 4.');
    expect(accented).toContain('4');
    expect(accented).not.toContain('{');
  });

  test('criterion 7: typing is not announced, and a run of commits that ends saved says nothing', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await recordRegions(page);
    await page.locator(`${editor} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    const typed = 'Zebra quartz';
    await page.keyboard.type(` ${typed}`, { delay: 120 });
    // Past the settle period, and the text is in the document.
    await page.waitForTimeout(2500);
    expect(await page.locator(`${editor} .de-editing-surface`).textContent()).toContain(typed);
    const said = await spoken(page);
    // Nothing said, in either region, quotes or echoes what was typed.
    for (const text of [...said.own, ...said.all]) expect(text).not.toMatch(/zebra|quartz|Typed/i);
    // Measured in this run (Chromium, the embed page's in-memory backend): keystrokes at 120 ms
    // flip the save state at each commit, and none of those flips was said.
    test.info().annotations.push({
      type: 'measured',
      description: `${typed.length + 1} keystrokes at 120 ms: ${said.own.length} sentences in the element's region`,
    });
    expect(said.own).toEqual([]);
  });
});

/** A UUID version 7 for this run (the identifier of a document made for one test). */
function uuid7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

const gated = 'doc-editor[data-test="gated"]';

interface GatedEmbed {
  service: {
    createDocument(content: unknown, opts: { id: string; grants: unknown[] }): string;
    backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
    setGrants(docId: string, grants: unknown[]): void;
  };
  docId: string;
  SPIKE_IDS: { region: string; legal: string };
  harness(el: Element): Promise<{
    caretIn(id: string, at: 'start' | 'end'): void;
    nodeText(id: string): string | null;
  }>;
}

/**
 * Opens the spike document under a new identifier for ada, who has a grant on the legal region. Her
 * commits wait at the channel until `window.__release()` is called (as fe-010-recovered-reopen.spec.ts).
 */
async function openGated(page: Page, docId: string): Promise<void> {
  await page.evaluate(async (docId) => {
    const e = (window as unknown as { __embed: GatedEmbed }).__embed;
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
    const w = window as unknown as { __release: () => void };
    const gate = new Promise<void>((resolve) => (w.__release = resolve));
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
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'gated';
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
  await expect(page.locator(`${gated} .de-editing-surface`)).toBeVisible();
}

/** Types into the end of the legal region and checks that the text landed there. */
async function typeIntoLegal(page: Page, text: string): Promise<void> {
  await page.evaluate(async () => {
    const e = (window as unknown as { __embed: GatedEmbed }).__embed;
    const h = await e.harness(document.querySelector('doc-editor[data-test="gated"]')!);
    h.caretIn(e.SPIKE_IDS.legal, 'end');
  });
  await page.keyboard.type(text);
  const legal = await page.evaluate(async () => {
    const e = (window as unknown as { __embed: GatedEmbed }).__embed;
    const h = await e.harness(document.querySelector('doc-editor[data-test="gated"]')!);
    return h.nodeText(e.SPIKE_IDS.legal);
  });
  expect(legal, 'the typed text is not in the legal region').toContain(text);
}

test.describe('FE-107 a save that holds, and edits set aside', () => {
  test('criterion 1: a save that holds is said as saving, then as saved when it is done', async ({
    page,
  }) => {
    await openEmbed(page);
    await openGated(page, uuid7());
    await recordRegions(page, gated);
    await typeIntoLegal(page, ' Held.');
    // The commit waits at the channel: the state that holds is said once, after the settle period.
    await expect.poll(async () => (await spoken(page)).own, { timeout: 15_000 }).toHaveLength(1);
    const first = (await spoken(page)).own[0]!;
    test.info().annotations.push({ type: 'measured', description: `held commit said: ${first}` });
    expect(['Saving changes.', 'Changes are not saved yet.']).toContain(first);
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect
      .poll(async () => (await spoken(page)).own, { timeout: 15_000 })
      .toEqual([first, 'All changes saved.']);
    // Each state was said once.
    expect(new Set((await spoken(page)).own).size).toBe(2);
  });

  test('criterion 4: edits the service refuses are announced as set aside, with their count', async ({
    page,
  }) => {
    const docId = uuid7();
    await openEmbed(page);
    await openGated(page, docId);
    await recordRegions(page, gated);
    await typeIntoLegal(page, ' Refused.');
    // The grant is withdrawn, then the held commit is sent: the room refuses it.
    await page.evaluate((docId) => {
      (window as unknown as { __embed: GatedEmbed }).__embed.service.setGrants(docId, []);
      (window as unknown as { __release: () => void }).__release();
    }, docId);
    await expect
      .poll(() => statusText(page, gated), { timeout: 20_000 })
      .toMatch(/could not be saved because your permissions changed/);
    const said = (await spoken(page)).all.filter((t) => /permissions changed/.test(t));
    // A single change is said with "A change"; several with their number, as the catalogue plurals do.
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toMatch(
      /^(A change|\d+ changes) could not be saved because your permissions changed\./,
    );
    expect(said[0]).toContain('kept in recovered edits');
    // The sentence is in a region of the same root as the content, and names no text or scope.
    const sameRoot = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const { root } = e.internals(document.querySelector(sel)!);
      const region = [...root.querySelectorAll('[role="status"]')].find((r) =>
        (r.textContent ?? '').includes('permissions changed'),
      );
      return region?.getRootNode() === root;
    }, gated);
    expect(sameRoot).toBe(true);
    for (const text of said) expect(text).not.toMatch(/Refused|rLegal|region:/);
  });
});
