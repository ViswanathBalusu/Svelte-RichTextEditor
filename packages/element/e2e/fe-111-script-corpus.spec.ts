/**
 * FE-111 criterion 3 (lane w1, 2026-11-27): typing in the corpus of right-to-left and complex scripts
 * (`SCRIPT_CORPUS` of test/input-method-matrix.ts: Arabic, Hebrew, Devanagari and Thai) in the main
 * editor, in each browser. The composition half of the criterion is the matrix's composition cases
 * for the same four scripts (input-method-matrix.ts), which the S1 composition suite runs in the
 * body, the footnote and the header, with and without a remote commit (e2e/s1-composition.spec.ts,
 * `arabic`, `hebrew`, `devanagari` and `thai`).
 *
 * Each text is typed key by key at the end of the first paragraph (right-to-left text in the
 * right-to-left demo document, the others in the default one). The paragraph must hold the text
 * that was there plus what was typed, once, and the caret must be at its end, so that a second
 * typed word continues it. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-111-script-corpus.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { expect, test } from '@playwright/test';
import { SCRIPT_CORPUS } from '../test/input-method-matrix.ts';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const MORE = ' !';

test.describe('typing in the script corpus (FE-111, criterion 3)', () => {
  for (const entry of SCRIPT_CORPUS) {
    test(`${entry.id}: the typed text is in the paragraph once, in order, and the caret stays at its end`, async ({
      page,
    }) => {
      await openEmbed(page);
      await mountEditor(page, { doc: entry.dir === 'rtl' ? 'rtl' : 'first' });

      const paragraph = (): Promise<string> =>
        page.evaluate((sel) => {
          const root = document.querySelector(sel)!.shadowRoot!;
          return (root.querySelector('p.de-p') as HTMLElement).textContent ?? '';
        }, editor);
      const before = await paragraph();

      // A click in the blank space after the first line, then End: the caret is at the logical end.
      const at = await page.evaluate(
        ({ sel, rtl }: { sel: string; rtl: boolean }) => {
          const root = document.querySelector(sel)!.shadowRoot!;
          const r = (root.querySelector('p.de-p') as HTMLElement).getBoundingClientRect();
          return { x: rtl ? r.left + 2 : r.right - 2, y: r.top + r.height / 2 };
        },
        { sel: editor, rtl: entry.dir === 'rtl' },
      );
      await page.mouse.click(at.x, at.y);
      await page.keyboard.press('End');

      await page.keyboard.type(entry.text);
      expect(await paragraph()).toBe(before + entry.text);

      // The caret is still at the end: more text continues the paragraph, it does not land inside it.
      await page.keyboard.type(MORE);
      expect(await paragraph()).toBe(before + entry.text + MORE);
    });
  }
});
