/**
 * FE-066 criterion 4 (lane w1): with the browser's spellcheck on, a misspelled word typed in the
 * editing surface is underlined by the browser. The underline is not in the DOM, so it is read from
 * a screenshot: the pixels of the paragraph's box are counted in the page (canvas), once after
 * correctly spelled words and once after misspelled ones. The text is black on white, so strongly
 * red pixels beyond the fringe of text rendering are the browser's spelling mark.
 *
 * Which browsers mark anything depends on the machine: a browser without a dictionary for the
 * document's language draws nothing. The test records what each project showed and skips, with the
 * reason, where no mark appears; it never passes on the attribute alone.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-066-spellcheck.spec.ts --retries=0
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';
import { SPIKE_IDS, record } from './helpers.ts';

/** Strongly red pixels in the paragraph's box (the spelling mark; the text itself is not red). */
async function redPixels(target: Locator): Promise<number> {
  const page = target.page();
  const shot = await target.screenshot();
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i]! > 170 && data[i + 1]! < 110 && data[i + 2]! < 110) red++;
    return red;
  }, shot.toString('base64'));
}

async function caretAtEnd(page: Page, id: string): Promise<void> {
  await page.evaluate(async (nodeId) => {
    const el = document.querySelector('doc-editor[data-test="one"]')!;
    const e = (
      window as unknown as {
        __embed: { harness(el: Element): Promise<{ caretIn(id: string, at: string): void }> };
      }
    ).__embed;
    (await e.harness(el)).caretIn(nodeId, 'end');
  }, id);
}

test('FE-066 the browser underlines a misspelled word inside the editing surface', async ({
  page,
}, info) => {
  await openEmbed(page);
  await mountEditor(page);
  // Paragraphs carry no identifier in the DOM; this one is found by its text.
  const target = page
    .locator('doc-editor .de-editing-surface .de-p')
    .filter({ hasText: 'Remote target paragraph' });
  await expect(target).toBeVisible();
  const attribute = await page
    .locator('doc-editor .de-editing-surface')
    .first()
    .getAttribute('spellcheck');
  expect(attribute).toBe('true');

  await caretAtEnd(page, SPIKE_IDS.after);
  await page.keyboard.type(' These words are spelled correctly. ');
  await page.waitForTimeout(2500);
  const afterCorrect = await redPixels(target);

  await page.keyboard.type('Thiss sentense contanes misspeled wurds. ');
  // The browser checks a word after its boundary and paints the mark a little later.
  let afterWrong = 0;
  for (let i = 0; i < 8 && afterWrong <= 4 * Math.max(afterCorrect, 25); i++) {
    await page.waitForTimeout(700);
    afterWrong = await redPixels(target);
  }
  const text = await target.innerText();
  record('fe-066-spellcheck', { attribute, afterCorrect, afterWrong, text });
  console.log(
    `FE-066 spellcheck ${info.project.name}: red pixels ${afterCorrect} after correct words, ${afterWrong} after misspelled words`,
  );
  expect(text).toContain('misspeled wurds');
  // Sub-pixel text rendering leaves a few reddish fringe pixels on black text (16 to 30 for the
  // first sentence, 53 for both, measured here); a mark under one word is about 85. So correct
  // words must stay under one word's worth, and a marked sentence must stand well clear of fringe.
  expect(afterCorrect).toBeLessThan(60);
  const marked = afterWrong > 4 * Math.max(afterCorrect, 25);
  test.skip(
    !marked,
    'this browser drew no spelling mark on this machine (no dictionary for the language, or spellcheck is off under automation)',
  );
  expect(afterWrong).toBeGreaterThan(200);
});
