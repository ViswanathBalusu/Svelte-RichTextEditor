/**
 * FE-099 criterion 3: with the page view shown (`view="print"`), the events of saving, a refused edit
 * and presence reach the element's live regions, as in the web view (FE-107; 02 §10). "Announced" is
 * checked as far as a browser test can: the sentence appears in a `role="status"` region of the same
 * shadow root, once. What a screen reader then says is the manual pass of FE-099 criterion 1.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57099 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-099-page-view-live.spec.ts`.
 * Firefox does not offer the page view (S5), so the tests are skipped there.
 */
import { expect, test, type Page } from '@playwright/test';
import { editorShown, mountEditor, openEmbed } from './embed-helpers.ts';

const one = 'doc-editor[data-test="one"]';
const gated = 'doc-editor[data-test="gated"]';

interface EmbedHooks {
  harness(el: Element): Promise<{
    caretIn(id: string, at: 'start' | 'end'): void;
    nodeText(id: string): string | null;
  }>;
  internals(el: Element): { root: ShadowRoot; liveRegion: HTMLElement };
  SPIKE_IDS: { region: string; legal: string };
  service: {
    createDocument(content: unknown, opts: { id: string; grants: unknown[] }): string;
    backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
    setGrants(docId: string, grants: unknown[]): void;
  };
  docId: string;
  backend(sub: string, role: string): unknown;
}

/** A desktop pointer: some machines with a touch screen answer `any-pointer: coarse` (FE-113). */
async function desktopPointer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
}

/** Records every text any `role="status"` region of the root shows, in order, on `window.__spoken`. */
function record(page: Page, target: string): Promise<void> {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const { root } = e.internals(document.querySelector(sel)!);
    const spoken: string[] = [];
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    const last = new Map<Element, string>();
    new MutationObserver(() => {
      for (const region of root.querySelectorAll('[role="status"]')) {
        const text = region.textContent ?? '';
        if (text !== '' && text !== last.get(region)) spoken.push(text);
        last.set(region, text);
      }
    }).observe(root, { childList: true, characterData: true, subtree: true });
  }, target);
}

const spoken = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __spoken: string[] }).__spoken]);

/** True when the page view is the one shown for the editor `target`. */
function pageViewShown(page: Page, target: string): Promise<boolean> {
  return page.evaluate(
    (sel) =>
      document.querySelector(sel)!.shadowRoot!.querySelector('.de-page-view .de-line') !== null,
    target,
  );
}

/** Puts the caret at the end of the legal region and types through the page view's input bridge. */
async function typeInLegal(page: Page, target: string, text: string): Promise<void> {
  await page.evaluate(async (sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const h = await e.harness(document.querySelector(sel)!);
    h.caretIn(e.SPIKE_IDS.legal, 'end');
  }, target);
  await page.locator(`${target} .de-page-bridge`).focus();
  await page.keyboard.type(text);
}

/**
 * Opens the spike document under a new identifier for ada, who has a grant on the legal region, with
 * the page view asked for. Her commits wait at the channel until `window.__release()` is called.
 */
async function openGated(page: Page, docId: string): Promise<void> {
  await page.evaluate(async (docId) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
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
    el.setAttribute('view', 'print');
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
  await editorShown(page, 'gated');
  await expect.poll(() => pageViewShown(page, gated)).toBe(true);
}

function uuid7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

test.describe('live regions with the page view shown (FE-099 criterion 3)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (S5)');
  });

  test('a save that holds is said as saving, then as saved, once each', async ({ page }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await openGated(page, uuid7());
    await record(page, gated);
    await typeInLegal(page, gated, ' Held.');
    await expect.poll(async () => (await spoken(page)).length, { timeout: 15_000 }).toBe(1);
    const first = (await spoken(page))[0]!;
    expect(['Saving changes.', 'Changes are not saved yet.']).toContain(first);
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect
      .poll(() => spoken(page), { timeout: 15_000 })
      .toEqual([first, 'All changes saved.']);
    expect(await pageViewShown(page, gated)).toBe(true);
  });

  test('edits the service refuses are said as set aside, with their count', async ({ page }) => {
    const docId = uuid7();
    await desktopPointer(page);
    await openEmbed(page);
    await openGated(page, docId);
    await record(page, gated);
    await typeInLegal(page, gated, ' Refused.');
    await page.evaluate((docId) => {
      (window as unknown as { __embed: EmbedHooks }).__embed.service.setGrants(docId, []);
      (window as unknown as { __release: () => void }).__release();
    }, docId);
    await expect
      .poll(async () => (await spoken(page)).join('|'), { timeout: 20_000 })
      .toMatch(/could not be saved because your permissions changed/);
    const said = (await spoken(page)).filter((t) => /permissions changed/.test(t));
    expect(said[0]).toMatch(
      /^(A change|\d+ changes) could not be saved because your permissions changed\./,
    );
  });

  test('an edit the guard refuses is said as not made, with the reason', async ({ page }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { sub: 'bob', name: 'one', attributes: { view: 'print' } });
    await expect.poll(() => pageViewShown(page, one)).toBe(true);
    await record(page, one);
    await typeInLegal(page, one, 'x');
    await expect
      .poll(async () => (await spoken(page)).join('|'))
      .toContain('That change was not made: you cannot change this part of the document.');
    // The region is in the same root as the pages, and the refused character is not said.
    const sameRoot = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const region = [...root.querySelectorAll('[role="status"]')].find((r) =>
        (r.textContent ?? '').includes('That change was not made'),
      );
      return region?.getRootNode() === root && root.querySelector('.de-page-view') !== null;
    }, one);
    expect(sameRoot).toBe(true);
    expect((await spoken(page)).join('|')).not.toMatch(/\bx\b/);
  });

  test('a collaborator who arrives and then leaves is named in the live region', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await page.evaluate(async () => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const make = (name: string, sub: string, target: string, view: boolean) => {
        let div = document.getElementById(target);
        if (!div) {
          div = document.createElement('div');
          div.id = target;
          document.body.append(div);
        }
        const el = document.createElement('doc-editor') as HTMLElement & {
          backend: unknown;
          resolveUsers: unknown;
        };
        el.dataset['test'] = name;
        if (view) el.setAttribute('view', 'print');
        const ready = new Promise<void>((resolve, reject) => {
          el.addEventListener('de-ready', () => resolve(), { once: true });
          el.addEventListener(
            'de-error',
            (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
            { once: true },
          );
        });
        el.backend = e.backend(sub, 'editor');
        el.resolveUsers = async (ids: readonly string[]) =>
          ids.map((id) => ({ id, name: 'Bob Example' }));
        el.setAttribute('doc-id', e.docId);
        div.append(el);
        return ready;
      };
      (window as unknown as { __make: typeof make }).__make = make;
      await make('one', 'ada', 'mount', true);
    });
    await editorShown(page, 'one');
    await expect.poll(() => pageViewShown(page, one)).toBe(true);
    await record(page, one);
    // The presence baseline is taken in the first moments, so the peer joins after that.
    await page.waitForTimeout(1500);
    await page.evaluate(() =>
      (window as unknown as { __make: (...a: unknown[]) => Promise<void> }).__make(
        'peer',
        'bob',
        'mount-peer',
        false,
      ),
    );
    await expect
      .poll(() => spoken(page), { timeout: 20_000 })
      .toContain('Bob Example joined the document.');
    await page.evaluate(() => {
      const peer = document.querySelector('doc-editor[data-test="peer"]') as HTMLElement & {
        destroy?: () => void;
      };
      peer.destroy?.();
      peer.remove();
    });
    await expect
      .poll(() => spoken(page), { timeout: 20_000 })
      .toContain('Bob Example left the document.');
    const all = await spoken(page);
    expect(all.filter((s) => s === 'Bob Example joined the document.')).toHaveLength(1);
    expect(all.filter((s) => s === 'Bob Example left the document.')).toHaveLength(1);
    expect(await pageViewShown(page, one)).toBe(true);
  });
});
