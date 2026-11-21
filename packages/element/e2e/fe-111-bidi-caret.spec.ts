/**
 * FE-111 criterion 2 (lane U-FE-097-112): in right-to-left text with mixed left-to-right runs, typing
 * keeps the logical order, and the selection grows as the browser grows it in a plain contenteditable
 * element with the same direction and text. The reference is the browser's own handling, so the test
 * does not assert an order of its own: it asserts that the editor and the reference select the same
 * text, step by step, in each browser. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-111-bidi-caret.spec.ts --project=chromium --project=firefox --project=webkit`.
 *
 * Criteria 3 (the input matrix over a corpus), 4 (the region clamp in right-to-left text) and 5 (the
 * PDF export) are not covered here.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const TYPED = ' abc 123 def';
const FIRST = 'مرحبا بالعالم';
const STEPS = 6;

/** The selected text in the editor's shadow root, or in the document when the browser has no shadow selection. */
function editorSelection(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot as
      (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    const s = root?.getSelection?.() ?? document.getSelection();
    return s ? s.toString() : '';
  }, editor);
}

test.describe('bidirectional text in the web view (FE-111, criterion 2)', () => {
  test('typing mixed direction text keeps its order, and selecting it selects what the browser selects', async ({
    page,
    browserName,
  }) => {
    // Firefox on Linux (Playwright 1.65, hosted runner and the Playwright container) puts the caret of
    // the plain reference element, at the logical end of its right-to-left text, where Shift+ArrowRight
    // selects nothing (Shift+ArrowLeft selects the last letter); on Windows it selects as in Chromium
    // and WebKit. The steps of the reference are then not those the test describes, so it cannot
    // compare the editor against it there. The other FE-111 specs run in Firefox on Linux.
    test.skip(
      browserName === 'firefox' && process.platform === 'linux',
      'Firefox on Linux moves the reference caret the other way at the end of a right-to-left line',
    );
    await openEmbed(page);
    await mountEditor(page, { doc: 'rtl' });

    // In a right-to-left line the logical end is at its left edge: a click in the blank space there
    // puts the caret at that end, and typing continues the text.
    const at = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const r = (root.querySelector('p.de-p') as HTMLElement).getBoundingClientRect();
      return { x: r.left + 2, y: r.top + r.height / 2 };
    }, editor);
    await page.mouse.click(at.x, at.y);
    // End moves to the logical end of the line; Firefox sometimes put the click at the start.
    await page.keyboard.press('End');
    await page.keyboard.type(TYPED);

    const text = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      return (root.querySelector('p.de-p') as HTMLElement).textContent;
    }, editor);
    expect(text).toBe(FIRST + TYPED);

    // The editor: from the end, Shift+Left one step at a time, reading what is selected.
    const fromEditor: string[] = [];
    // In right-to-left text the logical end is on the left, so the selection grows to the right.
    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press('Shift+ArrowRight');
      fromEditor.push(await editorSelection(page));
    }

    // The reference: the same text in a plain contenteditable element with the same direction.
    await page.evaluate(
      ({ first, typed }: { first: string; typed: string }) => {
        const ref = document.createElement('div');
        ref.id = 'u-fe-111-reference';
        ref.setAttribute('contenteditable', 'true');
        ref.setAttribute('dir', 'rtl');
        ref.style.cssText = 'position:fixed;left:0;top:0;width:360px;font-size:16px;';
        ref.textContent = first + typed;
        document.body.append(ref);
        ref.focus();
        const range = document.createRange();
        range.selectNodeContents(ref);
        range.collapse(false);
        const s = document.getSelection()!;
        s.removeAllRanges();
        s.addRange(range);
      },
      { first: FIRST, typed: TYPED },
    );
    const fromReference: string[] = [];
    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press('Shift+ArrowRight');
      fromReference.push(await page.evaluate(() => document.getSelection()!.toString()));
    }

    // Each step selects some text, and the two agree at every step.
    expect(fromReference.at(-1)).not.toBe('');
    expect(fromEditor.at(-1)).not.toBe('');
    expect(fromEditor).toEqual(fromReference);
  });

  // Editing in the middle of mixed text (lane w1, 2026-11-18): move the caret by the arrow keys,
  // delete both ways, and type. The text that results is the text a plain contenteditable element
  // gives for the same key presses, in each browser.
  test('moving the caret and deleting and typing in the middle of mixed text give what the browser gives', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'rtl' });

    const at = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const r = (root.querySelector('p.de-p') as HTMLElement).getBoundingClientRect();
      return { x: r.left + 2, y: r.top + r.height / 2 };
    }, editor);
    await page.mouse.click(at.x, at.y);
    // End moves to the logical end of the line; Firefox sometimes put the click at the start.
    await page.keyboard.press('End');
    await page.keyboard.type(TYPED);
    expect(
      await page.evaluate((sel) => {
        const root = document.querySelector(sel)!.shadowRoot!;
        return (root.querySelector('p.de-p') as HTMLElement).textContent;
      }, editor),
    ).toBe(FIRST + TYPED);

    const keys = [
      ...Array<string>(5).fill('ArrowRight'),
      'Backspace',
      'Backspace',
      'x',
      'Delete',
      'Delete',
      'ArrowLeft',
      'ArrowLeft',
      'y',
    ];
    for (const k of keys) await page.keyboard.press(k);
    const fromEditor = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      return (root.querySelector('p.de-p') as HTMLElement).textContent;
    }, editor);

    await page.evaluate(
      ({ first, typed }: { first: string; typed: string }) => {
        const ref = document.createElement('div');
        ref.id = 'w1-fe-111-edit-reference';
        ref.setAttribute('contenteditable', 'true');
        ref.setAttribute('dir', 'rtl');
        ref.style.cssText = 'position:fixed;left:0;top:0;width:360px;font-size:16px;';
        ref.textContent = first + typed;
        document.body.append(ref);
        ref.focus();
        const range = document.createRange();
        range.selectNodeContents(ref);
        range.collapse(false);
        const s = document.getSelection()!;
        s.removeAllRanges();
        s.addRange(range);
      },
      { first: FIRST, typed: TYPED },
    );
    for (const k of keys) await page.keyboard.press(k);
    const fromReference = await page.evaluate(
      () => document.getElementById('w1-fe-111-edit-reference')!.textContent,
    );

    expect(fromEditor).not.toBe(FIRST + TYPED);
    expect(fromEditor).toBe(fromReference);
  });
});
