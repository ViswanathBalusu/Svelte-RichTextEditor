/**
 * Region boundaries in the browser, through the element (FE-038 criterion 7, FE-039 criterion 4):
 * the core clamps a selection that starts inside a region through the view's selection hook
 * (packages/engine/src/regions.ts), and a body paragraph follows every region. The Node.js
 * versions of these cases are in packages/engine/test/regions.test.ts. The document is the embed
 * page's region document (demo/embed-page.ts): a paragraph, an open region with two paragraphs, a
 * paragraph, a region as the last block and the empty paragraph after it.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const IDS = {
  before: 'pBefore000000001',
  region: 'rMiddle000000001',
  first: 'pRegionFirst0001',
  last: 'pRegionLast00001',
  after: 'pAfter0000000001',
  endText: 'pEndText00000001',
  trailing: 'pTrailing0000001',
} as const;

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
const caret = (page: Page, id: string, at: 'start' | 'end') =>
  call<unknown>(page, 'caretIn', id, at);

/** The region's paragraphs, by identifier and text, from the document. */
async function regionParagraphs(page: Page): Promise<string[]> {
  const doc = await call<{ content: Array<{ type: string; content?: unknown[] }> }>(page, 'doc');
  const body = doc.content.find((n) => n.type === 'body') as {
    content: Array<{
      type: string;
      attrs?: { id?: string };
      content?: Array<{ content?: Array<{ text?: string }> }>;
    }>;
  };
  const region = body.content.find((n) => n.type === 'region' && n.attrs?.id === IDS.region)!;
  return (region.content ?? []).map((p) => (p.content ?? []).map((t) => t.text ?? '').join(''));
}

/** ProseMirror reads native selection changes on `selectionchange`, in a later task (S1 §4.2). */
const settle = (page: Page) => page.waitForTimeout(150);

test.describe('FE-038 selections stop at region boundaries', () => {
  test.beforeEach(async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'regions' });
  });

  test('Shift and arrows from inside a region stop at its boundary, both ways', async ({
    page,
  }) => {
    await caret(page, IDS.last, 'end');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await settle(page);
    expect(await selected(page)).not.toMatch(/After/);
    await caret(page, IDS.first, 'start');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await settle(page);
    const down = await selected(page);
    expect(down).toMatch(/Region first\./);
    expect(down).not.toMatch(/After/);
    await caret(page, IDS.first, 'start');
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await settle(page);
    expect(await selected(page)).not.toMatch(/Before/);
  });

  test('a drag from inside the region to the paragraph after it stays in the region', async ({
    page,
  }) => {
    const surface = page.locator('doc-editor .de-editing-surface');
    const from = await surface.locator('p', { hasText: 'Region first.' }).boundingBox();
    const to = await surface.locator('p', { hasText: 'After region.' }).boundingBox();
    expect(from && to).toBeTruthy();
    await page.mouse.move(from!.x + 4, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const s = await selected(page);
    expect(s).toMatch(/egion/);
    expect(s).not.toMatch(/After/);
  });

  test('Backspace at the region’s start and Delete at its end change nothing', async ({ page }) => {
    await caret(page, IDS.first, 'start');
    await page.keyboard.press('Backspace');
    await caret(page, IDS.last, 'end');
    await page.keyboard.press('Delete');
    await settle(page);
    expect(await text(page, IDS.before)).toBe('Before region.');
    expect(await text(page, IDS.after)).toBe('After region.');
    expect(await regionParagraphs(page)).toEqual(['Region first.', 'Region last.']);
  });

  test('Enter at the region’s end makes the new paragraph inside it', async ({ page }) => {
    await caret(page, IDS.last, 'end');
    await page.keyboard.press('Enter');
    await page.keyboard.type('New inside');
    await expect
      .poll(() => regionParagraphs(page))
      .toEqual(['Region first.', 'Region last.', 'New inside']);
    expect(await text(page, IDS.after)).toBe('After region.');
  });

  test('a collapsed caret moves across the boundary with the arrow keys', async ({ page }) => {
    await caret(page, IDS.last, 'end');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    await page.keyboard.type('X');
    await expect.poll(() => text(page, IDS.after)).toBe('XAfter region.');
    await caret(page, IDS.first, 'start');
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    await page.keyboard.type('Y');
    await expect.poll(() => text(page, IDS.before)).toBe('Before region.Y');
  });

  test('a selection that starts outside and extends into the region is not clamped', async ({
    page,
  }) => {
    await caret(page, IDS.before, 'end');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    await settle(page);
    expect(await selected(page)).toMatch(/Region first/);
  });
});

test.describe('FE-039 a body paragraph after every region', () => {
  test('Down at the end of the last region reaches the paragraph after it', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'regions' });
    await caret(page, IDS.endText, 'end');
    await page.keyboard.press('ArrowDown');
    await settle(page);
    await page.keyboard.type('Below');
    await expect.poll(() => text(page, IDS.trailing)).toBe('Below');
    expect(await text(page, IDS.endText)).toBe('End region text.');
  });
});
