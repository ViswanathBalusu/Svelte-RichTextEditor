/**
 * SEC-009 criterion 4, the comment and fill halves (lane w8, 2026-11-25). The first half of the
 * criterion (typing and export) is sec-009-event-scan.spec.ts. Here a scripted session comments on
 * selected words through the shell, and another fills a form field through `setFieldValue` and by
 * typing into the field's control. Afterwards every `de-*` event detail the page recorded is scanned
 * for the comment text, the filled value and each paragraph of the document: none may be found.
 * Content leaves the element only through explicit methods such as `getContent`.
 *
 * Events come from the embed page's recorder on `document`, so a recorded event has left the shadow
 * root. Chromium, Edge, Firefox and WebKit (playwright.config.ts projects).
 */
import { type Page, expect, test } from '@playwright/test';
import { FIELD_IDS, control, editorOf, mountFields } from './frw-helpers.ts';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const COMMENT = 'sec009commentmarker';
const FILLED = 'sec009fillmarker';

/** Asserts that no `de-*` event the page recorded carries any of `texts`. */
async function expectNoLeak(page: Page, texts: string[]): Promise<void> {
  const recorded = await events(page);
  expect(
    recorded.some((e) => e.name === 'de-ready'),
    'the session raised de-ready',
  ).toBe(true);
  for (const event of recorded) {
    if (!event.name.startsWith('de-')) continue;
    const detail = JSON.stringify(event.detail ?? null);
    for (const text of texts) {
      expect(detail, `${event.name} carries document text`).not.toContain(text);
    }
  }
}

/** The text of each non-empty paragraph of the editor `name`. */
async function paragraphs(page: Page, name: string): Promise<string[]> {
  const all = await page.locator(`${editorOf(name)} .de-editing-surface p`).allInnerTexts();
  return all.map((t) => t.trim()).filter((t) => t.length >= 4);
}

test('SEC-009: a comment session raises no de-* event that carries the comment or the document text', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { name: 'sec-009-comment', sub: 'ada', role: 'editor' });
  const one = page.locator(editorOf('sec-009-comment'));
  const surface = one.locator('.de-editing-surface');
  await surface.locator('p').first().click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  expect(
    await page.evaluate(
      (sel) =>
        (document.querySelector(sel) as unknown as { exec(command: string): unknown }).exec(
          'review.comment',
        ),
      editorOf('sec-009-comment'),
    ),
  ).toMatchObject({ ok: true });
  const box = one.locator('[data-dialog="comment"]');
  await expect(box).toBeVisible();
  await box.getByRole('textbox', { name: 'Comment' }).fill(COMMENT);
  await box.getByRole('button', { name: 'Post' }).click();
  await expect(box).toBeHidden();
  await expect.poll(() => one.locator('.de-comment-range').count()).toBeGreaterThan(0);
  await page.waitForTimeout(300);

  await expectNoLeak(page, [COMMENT, ...(await paragraphs(page, 'sec-009-comment'))]);
});

test('SEC-009: a fill session raises no de-* event that carries the value or the document text', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: 'sec-009-fill', sub: 'vic', fill: true });
  const set = await page.evaluate(
    async ([sel, value]) => {
      const el = document.querySelector(sel!) as unknown as {
        setFieldValue(key: string, value: unknown): Promise<unknown>;
      };
      return el.setFieldValue('tenant.name', value);
    },
    [editorOf('sec-009-fill'), FILLED],
  );
  expect(set).toEqual({ ok: true, confirmed: true });
  // The value is also typed into the control of the amount field, as a participant does.
  const amount = control(page, FIELD_IDS.amount, 'sec-009-fill');
  await amount.fill(`${FILLED}2`);
  await page.waitForTimeout(300);

  await expectNoLeak(page, [FILLED, ...(await paragraphs(page, 'sec-009-fill'))]);
});
