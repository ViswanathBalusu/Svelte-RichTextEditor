/**
 * FE-037 criterion 2 (lane V-FE-033-048), in a real browser through the element: a deletion that
 * crosses a region the user cannot edit is trimmed to the editable parts, and the shell says in its
 * live region that part of the deletion was kept. The region is locked for bob, who has no grant on
 * the spike document's region (as element.spec.ts PRO-088 sets it up). The notice names no scope.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-037-trimmed-announce.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const SAID = 'Part of that deletion was kept';

interface EmbedHooks {
  harness(el: Element): Promise<Record<string, (...a: unknown[]) => unknown>>;
  internals(el: Element): { root: ShadowRoot };
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

/** The text of every status region in the editor's shadow root, in one string. */
function statusText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const { root } = e.internals(document.querySelector(sel)!);
    return [...root.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? '').join('|');
  }, editor);
}

test.describe('FE-037 criterion 2: a trimmed deletion is announced', () => {
  test('a deletion across a locked region says that part of it was kept, and keeps the region', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { sub: 'bob' });
    const ids = await page.evaluate(
      () => (window as unknown as { __embed: EmbedHooks }).__embed.SPIKE_IDS,
    );
    await call(page, 'caretIn', ids.intro, 'end');
    // From the end of the intro, across the locked region, into the paragraph after it.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Delete');
    await expect.poll(() => statusText(page)).toContain(SAID);
    // The locked region's paragraph survives the deletion.
    expect(await call<string | null>(page, 'nodeText', ids.legal)).not.toBeNull();
    // The notice names no scope identifier.
    expect(await statusText(page)).not.toMatch(/rLegal|region:/);
  });
});
