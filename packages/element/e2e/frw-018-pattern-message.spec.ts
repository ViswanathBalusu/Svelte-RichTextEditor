/**
 * FRW-018 criterion 4 (lane w4) in the real element, with the shell, the core and the in-memory
 * backend of the embed page: the author gives a field a pattern and the message for an entry that
 * does not match it (`validation.message`; owner decision 187 of 2026-11-15) in the field properties
 * pane; the field then marks such an entry invalid and says what the author wrote, in the author's
 * editor and in the editor of a participant who fills the same document.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-018-pattern-message.spec.ts`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import {
  FIELD_IDS,
  confirmed,
  control,
  editorOf,
  mountFields,
  nodes,
  openPaneBySearch,
} from './frw-helpers.ts';

const PATTERN = '[A-Z]{2}[0-9]{4}';
const MESSAGE = 'Enter two letters and four digits, such as AB1234.';
const VALIDATION = { pattern: PATTERN, message: MESSAGE };

/** The attributes of the confirmed form field `id` in the editor `name`. */
async function attrs(page: Page, id: string, name = 'one'): Promise<Record<string, unknown>> {
  const field = nodes(await confirmed(page, name), 'form_field').find(
    (f) => f.attrs?.['id'] === id,
  );
  return field?.attrs ?? {};
}

/** The message element beside the control of the field `id` in the editor `name`. */
const alertOf = (page: Page, id: string, name = 'one'): Locator =>
  page.locator(`${editorOf(name)} .de-form-field[data-field="${id}"] [role="alert"]`);

/** The author sets the validation of the name field in the properties pane and applies it. */
async function authorGivesTheMessage(page: Page): Promise<void> {
  // Select the field in the document: its control takes focus, and the pane follows it.
  await control(page, FIELD_IDS.name).click();
  const pane = await openPaneBySearch(page, 'one', 'Field properties', 'fields');
  await expect(pane.locator('[data-fields="choose"]')).toHaveValue(FIELD_IDS.name);
  await pane.getByLabel('Validation (JSON object)').fill(JSON.stringify(VALIDATION));
  await pane.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(async () => (await attrs(page, FIELD_IDS.name))['validation'])
    .toEqual(VALIDATION);
  await expect(pane.locator('[data-status="apply"]')).toHaveText('');
}

test.describe('FRW-018 the message of a pattern', () => {
  test('the author gives the message in the properties pane, and the field says it for an entry that does not match', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'bob', role: 'editor' });
    await authorGivesTheMessage(page);

    const field = control(page, FIELD_IDS.name);
    const alert = alertOf(page, FIELD_IDS.name);
    // While typing: the entry does not match.
    await field.fill('ab12');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(MESSAGE);
    // The control is described by the message: its description ends with the author's words.
    expect(await field.getAttribute('aria-description')).toMatch(
      /\. Enter two letters and four digits, such as AB1234\.$/,
    );
    // Once the control is left the entry is submitted, kept and still invalid.
    await field.press('Tab');
    await expect(field).toHaveValue('ab12');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(alert).toHaveText(MESSAGE);

    // An entry that matches: no mark and no message, and the value is stored.
    await field.fill('AB1234');
    await field.press('Tab');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await expect(alert).toBeHidden();
    await expect.poll(async () => (await attrs(page, FIELD_IDS.name))['value']).toBe('AB1234');
  });

  test('a participant who fills the same document is told the author’s message', async ({
    page,
  }) => {
    await openEmbed(page);
    // The participant has the document open in the fill mode before the author changes the field.
    await mountFields(page, { name: 'two', sub: 'tessa', fill: true });
    await mountFields(page, { name: 'one', sub: 'bob', role: 'editor' });
    await authorGivesTheMessage(page);
    // The change of the definition reaches the participant's editor.
    await expect
      .poll(async () => (await attrs(page, FIELD_IDS.name, 'two'))['validation'])
      .toEqual(VALIDATION);

    const field = control(page, FIELD_IDS.name, 'two');
    const alert = alertOf(page, FIELD_IDS.name, 'two');
    await field.fill('1234AB');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(alert).toHaveText(MESSAGE);
    await field.press('Tab');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    // The embedding API reports the field with the same message.
    const reported = await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="two"]') as unknown as {
        validateFields(): Array<{
          key: string;
          problems: Array<{ code: string; message: string }>;
        }>;
      };
      return el.validateFields().find((r) => r.key === 'tenant.name')?.problems ?? [];
    });
    expect(reported.map((p) => [p.code, p.message])).toEqual([['pattern', MESSAGE]]);

    await field.fill('XY0001');
    await field.press('Tab');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await expect(alert).toBeHidden();
    await expect
      .poll(async () => (await attrs(page, FIELD_IDS.name, 'two'))['value'])
      .toBe('XY0001');
  });
});
