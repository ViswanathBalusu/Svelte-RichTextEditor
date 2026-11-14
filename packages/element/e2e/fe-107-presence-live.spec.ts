/**
 * FE-107 criterion 3 (lane V-FE-097-112): when a collaborator arrives or leaves, the live region of
 * the editor the reader has open announces it, with the name that `resolveUsers` gives for the
 * collaborator (UX-025). Two `<doc-editor>` elements on the same document, with two users of the
 * embed page's in-memory backend: the first one has `resolveUsers` set before it connects; the second
 * one is added, then removed. The first one's live region must say the name, once, for each change.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-107-presence-live.spec.ts --project=chromium --project=firefox --project=webkit --output <scratch dir>`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const reader = 'doc-editor[data-test="reader"]';
const NAME = 'Bob Example';

/** Mounts a `<doc-editor>` named `name` as `sub`, into the element with id `target`. */
async function mount(
  page: Page,
  opts: { name: string; sub: string; target: string; resolve: boolean },
): Promise<void> {
  await page.evaluate(
    async ({ name, sub, target, resolve, name2 }) => {
      const e = (window as unknown as { __embed: Record<string, unknown> }).__embed as unknown as {
        backend(sub: string, role: string): unknown;
        docId: string;
      };
      if (!document.getElementById(target)) {
        const div = document.createElement('div');
        div.id = target;
        document.body.append(div);
      }
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        resolveUsers: unknown;
      };
      el.dataset['test'] = name;
      const ready = new Promise<void>((resolveReady, reject) => {
        el.addEventListener('de-ready', () => resolveReady(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = e.backend(sub, 'editor');
      if (resolve) {
        el.resolveUsers = async (ids: readonly string[]) => ids.map((id) => ({ id, name: name2 }));
      }
      el.setAttribute('doc-id', e.docId);
      document.getElementById(target)!.append(el);
      await ready;
    },
    { ...opts, name2: NAME },
  );
}

/** Records every sentence the reader's live region shows, in order, on `window.__said`. */
function record(page: Page): Promise<void> {
  return page.evaluate((sel) => {
    const e = (
      window as unknown as { __embed: { internals(el: Element): { liveRegion: HTMLElement } } }
    ).__embed;
    const region = e.internals(document.querySelector(sel)!).liveRegion;
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text !== '') said.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }, reader);
}

const said = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __said: string[] }).__said]);

test.describe('presence announced by name in the live region (FE-107, criterion 3)', () => {
  test('a collaborator who arrives and then leaves is named in the reader’s live region', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, { name: 'reader', sub: 'ada', target: 'mount', resolve: true });
    await record(page);

    // The reader's presence baseline is taken in its first moments (presence-notices.ts): a peer who
    // arrives after that is a change, so the peer joins once the reader has settled.
    await page.waitForTimeout(1500);
    await mount(page, { name: 'peer', sub: 'bob', target: 'mount-peer', resolve: false });
    await expect
      .poll(() => said(page), { timeout: 20_000 })
      .toContain(`${NAME} joined the document.`);

    await page.evaluate(() => {
      const peer = document.querySelector('doc-editor[data-test="peer"]') as HTMLElement & {
        destroy?: () => void;
      };
      peer.destroy?.();
      peer.remove();
    });
    await expect
      .poll(() => said(page), { timeout: 20_000 })
      .toContain(`${NAME} left the document.`);

    // Each change is announced once, and the name is the resolved one, not the identifier.
    const sentences = await said(page);
    expect(sentences.filter((s) => s === `${NAME} joined the document.`)).toHaveLength(1);
    expect(sentences.filter((s) => s === `${NAME} left the document.`)).toHaveLength(1);
    expect(sentences.some((s) => s.includes('bob'))).toBe(false);
  });
});
