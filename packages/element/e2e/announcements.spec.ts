/**
 * The live region of the announcements (FE-107; 02 §10), in a real browser with the embed page and
 * its in-memory backend (as element.spec.ts uses them).
 *
 * Checked here: the region is in the element's shadow root, polite and atomic; typing makes the save
 * state change, and each change reaches the region once (criterion 1); a burst of notices given in
 * one task reaches the region in full and in order, one sentence after another (criterion 5).
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

  test('typing changes the save state, and the change reaches the region', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await record(page);
    await page.locator(`${editor} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed');
    await expect.poll(() => said(page)).toContain('All changes saved.');
    const sentences = await said(page);
    expect(sentences).toContain('Saving changes.');
    expect(sentences.indexOf('Saving changes.')).toBeLessThan(
      sentences.lastIndexOf('All changes saved.'),
    );
    // Each sentence follows a change: the same save state is never announced twice in a row.
    for (let i = 1; i < sentences.length; i++) expect(sentences[i]).not.toBe(sentences[i - 1]);
  });

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
        announcer.notify({ kind: 'sync', sync: 'unsaved' }),
        announcer.notify({ kind: 'rejected', where: 'the body', reason: 'Read-only.' }),
        announcer.notify({ kind: 'recovered', count: 2 }),
        announcer.notify({ kind: 'sync', sync: 'saving' }),
        announcer.notify({ kind: 'presence', change: 'arrived', userId: 'nobody' }),
        announcer.notify({ kind: 'sync', sync: 'saved' }),
      ];
    }, editor);
    expect(accepted).toEqual([true, true, true, true, true, true]);
    const expected = [
      'Changes are not saved yet.',
      'An edit was not applied at the body. Read-only.',
      'Edits set aside for recovery: 2.',
      'Saving changes.',
      'A collaborator joined the document.',
      'All changes saved.',
    ];
    await expect.poll(() => said(page)).toEqual(expected);
  });
});
