/**
 * FE-111 criterion 4 (lane w1, 2026-11-18): in right-to-left text, the caret and the selection are
 * clamped at region boundaries as they are in left-to-right text (e2e/regions.spec.ts, FE-038).
 * The document is the embed page's right-to-left region document (demo/embed-page.ts, `rtl-regions`):
 * `settings.dir` is `rtl`, and the body holds a paragraph, a region of two paragraphs and a
 * paragraph after it, all in Arabic. In right-to-left text ArrowLeft moves forward in the text and
 * ArrowRight moves back. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-111-rtl-regions.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const IDS = {
  before: 'pRtlBefore000001',
  region: 'rRtlMiddle000001',
  first: 'pRtlFirst0000001',
  last: 'pRtlLast00000001',
  after: 'pRtlAfter0000001',
} as const;
const BEFORE = 'قبل المنطقة';
const FIRST = 'أول المنطقة';
const LAST = 'آخر المنطقة';
const AFTER = 'بعد المنطقة';

/** Calls a method of the spike harness of the editor on the page. */
function call<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ name, args }) => {
      const e = (
        window as unknown as {
          __embed: { harness(el: Element): Promise<Record<string, (...a: unknown[]) => unknown>> };
        }
      ).__embed;
      const h = await e.harness(document.querySelector('doc-editor[data-test="one"]')!);
      return h[name]!(...args) as T;
    },
    { name, args },
  );
}

const text = (page: Page, id: string) => call<string | null>(page, 'nodeText', id);
const selected = (page: Page) => call<string>(page, 'selectedText');
/** ProseMirror reads native selection changes on `selectionchange`, in a later task (S1 §4.2). */
const settle = (page: Page) => page.waitForTimeout(150);

/** Puts the caret in a paragraph and waits for the editor to have it, before the keys that extend it. */
const caret = async (page: Page, id: string, at: 'start' | 'end') => {
  const placed = await call<unknown>(page, 'caretIn', id, at);
  await settle(page);
  return placed;
};

test.describe('FE-111 criterion 4: region boundaries in right-to-left text', () => {
  test.beforeEach(async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'rtl-regions' });
    // The surface is right-to-left, so the keys below move as the test comments say.
    const dir = await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
      return getComputedStyle(root.querySelector('p.de-p')!).direction;
    });
    expect(dir).toBe('rtl');
  });

  test('Shift and arrows from the end of the region stop at its boundary, forward in the text', async ({
    page,
  }) => {
    await caret(page, IDS.last, 'end');
    // Back in right-to-left text is ArrowRight: two characters back, then select forward past the end.
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
    // Forward is ArrowLeft, and then down a line.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowDown');
    await settle(page);
    const s = await selected(page);
    expect(s).toBe(LAST.slice(-2));
    expect(s).not.toContain(AFTER.slice(0, 3));
    expect(await text(page, IDS.after)).toBe(AFTER);
  });

  test('Shift and arrows from the start of the region stop at its boundary, back in the text', async ({
    page,
  }) => {
    await caret(page, IDS.first, 'start');
    // Forward in right-to-left text is ArrowLeft: two characters on, then select back past the start.
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
    // Back is ArrowRight, and then up a line.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    await settle(page);
    const s = await selected(page);
    expect(s).toBe(FIRST.slice(0, 2));
    expect(s).not.toContain(BEFORE.slice(0, 3));
    expect(await text(page, IDS.before)).toBe(BEFORE);
  });

  test('a selection that stays inside the region is kept, in both paragraphs of it', async ({
    page,
  }) => {
    await caret(page, IDS.first, 'start');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
    await settle(page);
    expect(await selected(page)).toBe(FIRST.slice(0, 3));
    await caret(page, IDS.first, 'end');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await settle(page);
    const s = await selected(page);
    expect(s).not.toContain(AFTER.slice(0, 3));
    expect(s).toContain(LAST.slice(0, 3));
  });

  test('Backspace at the start of the region and Delete at its end change nothing', async ({
    page,
  }) => {
    await caret(page, IDS.first, 'start');
    await page.keyboard.press('Backspace');
    await caret(page, IDS.last, 'end');
    await page.keyboard.press('Delete');
    await settle(page);
    expect(await text(page, IDS.before)).toBe(BEFORE);
    expect(await text(page, IDS.after)).toBe(AFTER);
    expect(await text(page, IDS.first)).toBe(FIRST);
    expect(await text(page, IDS.last)).toBe(LAST);
  });

  test('a drag from inside the region to the paragraph after it stays in the region', async ({
    page,
  }) => {
    const surface = page.locator('doc-editor .de-editing-surface');
    const from = await surface.locator('p', { hasText: FIRST }).boundingBox();
    const to = await surface.locator('p', { hasText: AFTER }).boundingBox();
    expect(from && to).toBeTruthy();
    await page.mouse.move(from!.x + from!.width - 4, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const s = await selected(page);
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain(AFTER.slice(0, 3));
  });
});
