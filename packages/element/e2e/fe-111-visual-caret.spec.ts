/**
 * FE-111 criterion 2 (lane V-FE-097-112): in right-to-left text with mixed left-to-right runs, the
 * caret moves across the display order as the browser moves it in a plain contenteditable element.
 * The earlier test (e2e/fe-111-bidi-caret.spec.ts) compares the selected text only. This one compares
 * where the collapsed caret is drawn: after each ArrowRight from the logical end, the distance from the
 * paragraph's right edge to the caret is measured in the editor and in a reference element with the
 * same direction, width, font and text. The reference is the browser's own bidi handling, so the test
 * asserts no order of its own. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-111-visual-caret.spec.ts --project=chromium --project=firefox --project=webkit --output <scratch dir>`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const TYPED = ' abc 123 def';
const FIRST = 'مرحبا بالعالم';
const STEPS = 8;
const REFERENCE_ID = 'v-fe-097-112-fe-111-reference';

/** The caret's drawn left edge, measured from the right edge of `box` (right-to-left text). */
interface CaretAt {
  fromRight: number;
  text: string;
}

/** Distance from the right edge of the editor's first paragraph to the collapsed caret. */
function editorCaret(page: Page): Promise<CaretAt> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot as
      (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    const p = root!.querySelector('p.de-p') as HTMLElement;
    const s = root?.getSelection?.() ?? document.getSelection();
    const range = s!.getRangeAt(0);
    const at = range.getBoundingClientRect();
    return { fromRight: p.getBoundingClientRect().right - at.left, text: p.textContent ?? '' };
  }, editor);
}

/** The reference's caret, measured the same way, after the same key presses. */
function referenceCaret(page: Page): Promise<CaretAt> {
  return page.evaluate((id) => {
    const ref = document.getElementById(id)!;
    const at = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { fromRight: ref.getBoundingClientRect().right - at.left, text: ref.textContent ?? '' };
  }, REFERENCE_ID);
}

test.describe('bidirectional caret in the web view (FE-111, criterion 2, visual)', () => {
  // WebKit reports the selection of a shadow root retargeted to the document: its anchor is the
  // host's parent at offset 0, and the collapsed caret has an empty rect. Measured on 2026-11-13
  // (lane V-FE-097-112). Chromium and Firefox read the caret inside the shadow root.
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'WebKit gives the shadow root selection a retargeted anchor and an empty caret rect',
  );

  test('ArrowRight from the end draws the caret where the browser draws it in a plain element', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { doc: 'rtl' });

    // In a right-to-left line the logical end is at its left edge (as in the earlier test).
    const at = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const r = (root.querySelector('p.de-p') as HTMLElement).getBoundingClientRect();
      return { x: r.left + 2, y: r.top + r.height / 2 };
    }, editor);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.type(TYPED);

    const text = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      return (root.querySelector('p.de-p') as HTMLElement).textContent;
    }, editor);
    expect(text).toBe(FIRST + TYPED);

    // The reference copies the editor's paragraph: width, font and direction.
    const font = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const p = root.querySelector('p.de-p') as HTMLElement;
      const cs = getComputedStyle(p);
      return {
        width: p.getBoundingClientRect().width,
        font: {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          letterSpacing: cs.letterSpacing,
          wordSpacing: cs.wordSpacing,
          lineHeight: cs.lineHeight,
        },
      };
    }, editor);

    // Editor: from the logical end, ArrowRight one step at a time.
    const fromEditor: CaretAt[] = [];
    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press('ArrowRight');
      fromEditor.push(await editorCaret(page));
    }

    // Reference: the same text, width and font, the same key presses.
    await page.evaluate(
      ([id, text, width, f]) => {
        const ref = document.getElementById(id) ?? document.createElement('div');
        ref.id = id;
        ref.setAttribute('contenteditable', 'true');
        ref.setAttribute('dir', 'rtl');
        ref.style.cssText = `position:fixed;left:0;top:0;width:${width}px;white-space:pre-wrap;`;
        Object.assign(ref.style, f);
        ref.textContent = text;
        document.body.append(ref);
        ref.focus();
        const range = document.createRange();
        range.selectNodeContents(ref);
        range.collapse(false);
        const s = document.getSelection()!;
        s.removeAllRanges();
        s.addRange(range);
      },
      [REFERENCE_ID, FIRST + TYPED, font.width, font.font] as const,
    );
    const fromReference: CaretAt[] = [];
    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press('ArrowRight');
      fromReference.push(await referenceCaret(page));
    }

    // The caret moved, and the editor draws it where the reference does, at every step.
    const distinct = new Set(fromEditor.map((c) => c.fromRight.toFixed(1)));
    expect(distinct.size, JSON.stringify({ fromEditor, fromReference })).toBeGreaterThan(1);
    for (const c of fromEditor) expect(Number.isFinite(c.fromRight)).toBe(true);
    for (let i = 0; i < STEPS; i++) {
      expect(Math.abs(fromEditor[i]!.fromRight - fromReference[i]!.fromRight)).toBeLessThanOrEqual(
        1,
      );
    }
    // The text is the one typed, and it is what the reference holds.
    expect(fromReference.at(-1)!.text).toBe(FIRST + TYPED);
  });
});
