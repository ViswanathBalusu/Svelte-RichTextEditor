/**
 * The live region of the announcements (FE-107; 02 §10), in a real browser with the embed page and
 * its in-memory backend (as element.spec.ts uses them).
 *
 * Checked here: the region is in the element's shadow root, polite and atomic; a burst of notices
 * given in one task reaches the region in full and in order, one sentence after another
 * (criterion 5).
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface Notice {
  kind: string;
  [key: string]: unknown;
}

interface EmbedHooks {
  internals(el: Element): {
    root: ShadowRoot;
    liveRegion: HTMLElement;
    announcer: { notify(n: Notice): boolean } | null;
  };
}

/** Starts recording every text the live region shows, in order, on `window.__said`. */
function record(page: Page): Promise<void> {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const region = e.internals(document.querySelector(sel)!).liveRegion;
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text !== '') said.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }, editor);
}

const said = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __said: string[] }).__said]);

test.describe('FE-107 announcements in a live region of the shadow root', () => {
  test('the region is polite, atomic and inside the shadow root', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const region = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = document.querySelector(sel)!;
      const { root, liveRegion } = e.internals(el);
      return {
        inRoot: liveRegion.getRootNode() === root,
        role: liveRegion.getAttribute('role'),
        live: liveRegion.getAttribute('aria-live'),
        atomic: liveRegion.getAttribute('aria-atomic'),
      };
    }, editor);
    expect(region).toEqual({ inRoot: true, role: 'status', live: 'polite', atomic: 'true' });
  });

  // The save state reaching the region (criterion 1) and typing saying nothing (criterion 7) are
  // in fe-107-live-regions.spec.ts: a save state is announced only once it has held (ADR 0376).

  test('a burst of notices in one task reaches the region in full and in order', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await record(page);
    const accepted = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const announcer = e.internals(document.querySelector(sel)!).announcer!;
      return [
        announcer.notify({ kind: 'rejected', where: 'the body', reason: 'Read-only.' }),
        announcer.notify({ kind: 'recovered', count: 2 }),
        announcer.notify({ kind: 'presence', change: 'arrived', userId: 'nobody' }),
        announcer.notify({ kind: 'rejected', where: 'a table', reason: 'Too large.' }),
        announcer.notify({ kind: 'recovered', count: 1 }),
        // A save state is said once it has held, so it comes after the notices of the burst.
        announcer.notify({ kind: 'sync', sync: 'unsaved' }),
      ];
    }, editor);
    expect(accepted).toEqual([true, true, true, true, true, true]);
    const expected = [
      'An edit was not applied at the body. Read-only.',
      'Edits set aside for recovery: 2.',
      'A collaborator joined the document.',
      'An edit was not applied at a table. Too large.',
      'Edits set aside for recovery: 1.',
      'Changes are not saved yet.',
    ];
    await expect.poll(() => said(page)).toEqual(expected);
  });
});
