/**
 * FE-005 criterion 1 (lane U-FE-001-016): a host removes the element and inserts it again in the
 * same task. The selection and the scroll position must be unchanged afterwards. The check reads
 * the selection through the open shadow root (`ShadowRoot.getSelection`, Chromium only), so the
 * test runs in Chromium and skips elsewhere. Uses the embed page as fe-lifecycle.spec.ts does.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

test.describe('FE-005 criterion 1: a same-task move keeps selection and scroll', () => {
  // The browser drops the selection and the scroll position with the removed subtree. The element
  // keeps the last scroll position (scroll events) and the focus, and restores both when it
  // connects again (src/doc-editor.ts connectedCallback).
  test('selection and scroll position survive remove and insert in one task', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'ShadowRoot.getSelection is read in Chromium only',
    );
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const surface = page.locator(`${editor} .de-editing-surface`);
    // Make the body long enough to scroll: forty paragraphs typed at the end.
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Line ${i}`);
    }
    // Put the caret in the middle of a line so the offset is not at a boundary.
    await surface.locator('p', { hasText: 'Line 20' }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    const read = () =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        const root = el.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null };
        const s = root.getSelection?.() ?? null;
        return {
          anchorText: s?.anchorNode?.textContent ?? null,
          anchorOffset: s?.anchorOffset ?? null,
          focusOffset: s?.focusOffset ?? null,
          pageScrollY: window.scrollY,
        };
      }, editor);

    // The editor has no scroll container of its own: the page scrolls (shell.css), so the page is
    // scrolled to a known position before the move.
    await page.evaluate(() => window.scrollTo(0, 120));
    await page.waitForFunction(() => window.scrollY > 0);
    const before = await read();
    expect(before.anchorText).not.toBeNull();
    expect(before.pageScrollY).toBeGreaterThan(0);

    // Remove and insert in the same task, in the other container.
    await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const other = document.getElementById(
        el.parentElement!.id === 'mount' ? 'mount-2' : 'mount',
      )!;
      el.remove();
      other.append(el);
      await new Promise((r) => setTimeout(r, 50));
    }, editor);

    const after = await read();
    expect(after).toEqual(before);
  });
});
