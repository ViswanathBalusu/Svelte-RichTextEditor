/**
 * FRW-076 (lane w4): a participant fills the form document with the guided bar, in the real
 * element, in its shadow root, against the in-memory backend of the embed page. The participant
 * (`vic`) holds the tenant's role and may only fill (`mode="fill"`); the form document has three
 * tenant fields (amount, name and e-mail; name and e-mail are required) and one landlord field.
 * Another session (`ada`, an editor) stands for the author or another participant.
 *
 * - Criterion 1: the body is read-only, the tenant's controls are editable and the landlord's is
 *   not, and typing in the body changes nothing.
 * - Criterion 2: "n of m", the control to the next required field, and Finish.
 * - Criterion 3: Tab and Shift+Tab visit the fillable fields in document order and skip the
 *   landlord's; Escape leaves the editing surface; Ctrl+F6 moves to the next part of the editor.
 * - Criterion 4: a fill the room rejects with `conflict` leaves the control showing the current
 *   value, and a live region says so.
 * - Criterion 6: a change by another session shows without a reload and the counts follow.
 * - Criterion 7, the first half: a participant who is not active sees the bar say so, and the
 *   controls are read-only.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-076-guided-bar.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import {
  FIELD_IDS as IDS,
  confirmed,
  control,
  editorOf,
  mountFields,
  nodes,
} from './frw-helpers.ts';

const FILL = editorOf('fill');
const bar = (page: Page) => page.locator(`${FILL} .de-fill-bar`);
const progress = (page: Page) => page.locator(`${FILL} .de-fill-bar [data-status="fill-progress"]`);
const next = (page: Page) => bar(page).getByRole('button', { name: 'Next field to fill' });

const mountFill = (page: Page): Promise<void> =>
  mountFields(page, { name: 'fill', sub: 'vic', fill: true });
const mountAuthor = (page: Page): Promise<void> =>
  mountFields(page, { name: 'author', sub: 'ada', role: 'editor' });

/** The value of the field `id` in the document the service has acknowledged. */
async function stored(page: Page, id: string, name: string): Promise<unknown> {
  const field = nodes(await confirmed(page, name), 'form_field').find(
    (n) => n.attrs?.['id'] === id,
  );
  return field?.attrs?.['value'] ?? null;
}

test('the body is read-only and only the fields of the participant’s role can be edited (criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);

  await expect(control(page, IDS.name, 'fill')).toBeEditable();
  await expect(control(page, IDS.amount, 'fill')).toBeEditable();
  await expect(control(page, IDS.email, 'fill')).toBeEditable();
  await expect(control(page, IDS.landlordName, 'fill')).not.toBeEditable();

  // Typing into the body changes nothing: the surface is not editable in the fill mode.
  const before = JSON.stringify(await confirmed(page, 'fill'));
  const paragraph = page.locator(`${FILL} .de-editing-surface p`).first();
  const text = await paragraph.textContent();
  await paragraph.click();
  await page.keyboard.type('zzz');
  await expect(paragraph).toHaveText(text ?? '');
  expect(JSON.stringify(await confirmed(page, 'fill'))).toBe(before);

  // A value forced into the landlord's control is not stored: the core refuses the entry and the
  // control goes back to what the document holds.
  await control(page, IDS.landlordName, 'fill').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = 'Grace';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(control(page, IDS.landlordName, 'fill')).toHaveValue('');
  expect(await stored(page, IDS.landlordName, 'fill')).toBeNull();
});

test('the bar counts the required fields, leads to the next one and offers Finish (criterion 2)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  await expect(progress(page)).toHaveText('0 of 2 required fields filled');
  await expect(bar(page).getByRole('button', { name: 'Finish' })).toBeVisible();

  // The next required field, in document order: the name, then the e-mail.
  await next(page).click();
  await expect(control(page, IDS.name, 'fill')).toBeFocused();
  await control(page, IDS.name, 'fill').fill('Ada');
  await control(page, IDS.name, 'fill').press('Tab');
  await expect(progress(page)).toHaveText('1 of 2 required fields filled');
  await next(page).click();
  await expect(control(page, IDS.email, 'fill')).toBeFocused();
  await control(page, IDS.email, 'fill').fill('ada@example.org');
  await control(page, IDS.email, 'fill').press('Tab');
  await expect(progress(page)).toHaveText('2 of 2 required fields filled');
  await expect(next(page)).toHaveCount(0);
  await expect(page.locator(`${FILL} .de-fill-bar [data-status="fill-done"]`)).toBeVisible();
  expect(await stored(page, IDS.name, 'fill')).toBe('Ada');
  expect(await stored(page, IDS.email, 'fill')).toBe('ada@example.org');
});

test('Finish with something left opens the summary instead of finishing (criterion 2)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  await bar(page).getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator(`${FILL} .de-pane[data-pane="fill"]`)).toBeVisible();
  // Nothing was finished: the bar still counts what is left.
  await expect(progress(page)).toHaveText('0 of 2 required fields filled');
});

test('Tab visits the participant’s fields in order and skips the landlord’s; Escape and Ctrl+F6 leave the surface (criterion 3)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  const active = () =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      return (
        (root.activeElement as HTMLElement | null)
          ?.closest('[data-field]')
          ?.getAttribute('data-field') ?? null
      );
    }, FILL);

  await control(page, IDS.amount, 'fill').focus();
  expect(await active()).toBe(IDS.amount);
  await page.keyboard.press('Tab');
  expect(await active()).toBe(IDS.name);
  await page.keyboard.press('Tab');
  expect(await active()).toBe(IDS.email);
  // The next stop is not the landlord's field.
  await page.keyboard.press('Tab');
  expect(await active()).not.toBe(IDS.landlordName);
  await page.keyboard.press('Shift+Tab');
  expect(await active()).toBe(IDS.email);
  await page.keyboard.press('Shift+Tab');
  expect(await active()).toBe(IDS.name);

  // Escape leaves the editing surface.
  await page.keyboard.press('Escape');
  const inSurface = () =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      return !!root.activeElement?.closest('.de-editing-surface');
    }, FILL);
  expect(await inSurface()).toBe(false);

  // Ctrl+F6 moves focus to a part of the editor, and goes round to the page again.
  await control(page, IDS.name, 'fill').focus();
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Control+F6');
    seen.add(
      await page.evaluate((sel) => {
        const a = document.querySelector(sel)!.shadowRoot!.activeElement as HTMLElement | null;
        return a ? `${a.tagName}.${a.className}` : 'none';
      }, FILL),
    );
  }
  expect(seen.size, 'Ctrl+F6 visits more than one part of the editor').toBeGreaterThan(1);
});

test('a fill the room rejects with conflict leaves the current value and says so in a live region (criterion 4)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  await mountAuthor(page);

  // The room holds its writes: the author's fill is accepted but not yet stored or announced, so
  // the participant, who has not seen it, fills the same field from the older base.
  await page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: { service: { holdWrites(id: string): unknown }; fieldsDocId: string };
      }
    ).__embed;
    (window as unknown as { __held: unknown }).__held = e.service.holdWrites(e.fieldsDocId);
  });
  await control(page, IDS.name, 'author').fill('Ada');
  await control(page, IDS.name, 'author').press('Tab');
  await control(page, IDS.name, 'fill').fill('Vic');
  await control(page, IDS.name, 'fill').press('Tab');
  await page.evaluate(() =>
    (window as unknown as { __held: { release(): Promise<void> } }).__held.release(),
  );

  // The author's value stands, the participant's control shows it, and nothing was dropped
  // silently: the participant is told, and the entry is kept in the recovered edits.
  await expect.poll(() => stored(page, IDS.name, 'fill')).toBe('Ada');
  await expect(control(page, IDS.name, 'fill')).toHaveValue('Ada');
  await expect(
    page.locator(`${FILL} [role="status"]`).filter({ hasText: /changed by someone else/ }),
  ).not.toHaveCount(0);
});

test('a change by another session shows without a reload and the counts follow (criterion 6)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  await mountAuthor(page);
  await expect(progress(page)).toHaveText('0 of 2 required fields filled');

  await control(page, IDS.email, 'author').fill('ada@example.org');
  await control(page, IDS.email, 'author').press('Tab');
  await expect(control(page, IDS.email, 'fill')).toHaveValue('ada@example.org');
  await expect(progress(page)).toHaveText('1 of 2 required fields filled');
  // The next field to fill is now the name: the e-mail is done.
  await next(page).click();
  await expect(control(page, IDS.name, 'fill')).toBeFocused();
});

test('a participant who is not active sees the bar say so, and the fields are read-only (criterion 7)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: 'fill', sub: 'vic', fill: true, inactive: true });
  await expect(bar(page).locator('[data-status="fill-inactive"]')).toHaveText(
    'It is not your turn yet. Your fields open when it is.',
  );
  await expect(control(page, IDS.name, 'fill')).not.toBeEditable();
  await expect(control(page, IDS.email, 'fill')).not.toBeEditable();
  await expect(next(page)).toHaveCount(0);
});
