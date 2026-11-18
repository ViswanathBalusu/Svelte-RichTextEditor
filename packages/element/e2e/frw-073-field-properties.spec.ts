/**
 * FRW-073 (lane w4): the field properties pane in the real element, with the shell, the core and
 * the in-memory backend of the embed page. An editor selects a field in the document, opens the
 * pane, reads the field's properties in labelled controls, changes them with the keyboard, and
 * the change is read back from the confirmed document (one commit of attribute changes); one undo
 * takes it back. An entry the document cannot hold is announced and not committed. A commenter
 * gets the pane read-only.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-073-field-properties.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { FIELD_IDS, confirmed, control, editorOf, mountFields, nodes } from './frw-helpers.ts';

const EDITOR = editorOf('one');

/** The attributes of the confirmed form field `id`. */
async function attrs(page: Page, id: string): Promise<Record<string, unknown>> {
  const field = nodes(await confirmed(page, 'one'), 'form_field').find(
    (f) => f.attrs?.['id'] === id,
  );
  return field?.attrs ?? {};
}

const confirmedSeq = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { core: { confirmedSeq: { get(): number } } } };
        };
      }
    ).__embed;
    return e
      .internals(document.querySelector('doc-editor[data-test="one"]')!)
      .editor.core.confirmedSeq.get();
  });

/** Opens the pane as its command does. */
async function openPane(page: Page): Promise<Locator> {
  await page.keyboard.press('Alt+q');
  await expect(page.locator(`${EDITOR} [role="combobox"]`)).toBeFocused();
  await page.keyboard.type('Field properties');
  await expect(page.locator(`${EDITOR} [role="option"]`).first()).toContainText('Field properties');
  await page.keyboard.press('Enter');
  const pane = page.locator(`${EDITOR} .de-pane[data-pane="fields"]`);
  await expect(pane).toBeVisible();
  return pane;
}

/** The rules of WCAG 2.2 A and AA that axe finds broken in the pane. */
async function axeViolations(page: Page): Promise<string[]> {
  const axe = await new AxeBuilder({ page })
    .include({ fromShadowDom: [EDITOR, '.de-pane[data-pane="fields"]'] })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return axe.violations.map((v) => v.id);
}

/** The twelve properties of 12 §3.2, by the label of their control, in the panel's order. */
const LABELS = [
  'Key',
  'Kind',
  'Label',
  'Assignee (role)',
  'Required',
  'Read-only',
  'Default value',
  'Placeholder',
  'Options',
  'Format (JSON object)',
  'Validation (JSON object)',
  'Width (points)',
];

test.describe('FRW-073 the field properties pane', () => {
  test('an editor reads and changes the properties of the selected field with the keyboard', async ({
    page,
    browserName,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'bob', role: 'editor' });
    // Select the field in the document: its control takes focus.
    await control(page, FIELD_IDS.name).click();
    // The command search is opened from the text: its shortcut is not heard inside a field control.
    await page.locator(`${EDITOR} .de-editing-surface p`).first().click();
    const pane = await openPane(page);

    // Criterion 1: the pane shows the selected field, one labelled control per property.
    await expect(pane.locator('[data-fields="choose"]')).toHaveValue(FIELD_IDS.name);
    for (const label of LABELS) await expect(pane.getByLabel(label, { exact: true })).toBeVisible();
    await expect(pane.getByLabel('Key', { exact: true })).toHaveValue('tenant.name');
    await expect(pane.getByLabel('Kind', { exact: true })).toHaveValue('text');
    await expect(pane.getByLabel('Label', { exact: true })).toHaveValue('Name');
    await expect(pane.getByLabel('Assignee (role)')).toHaveValue('role_tenant');
    // The assignee is chosen from the roles, by name.
    const roleOptions = await pane
      .getByLabel('Assignee (role)')
      .evaluate((select) =>
        [...(select as HTMLSelectElement).options].map((o) => o.textContent?.trim()),
      );
    expect(roleOptions).toEqual(['No role', 'Tenant', 'Landlord']);
    await expect(pane.getByLabel('Required', { exact: true })).toBeChecked();
    await expect(pane.getByLabel('Read-only', { exact: true })).not.toBeChecked();
    // `sensitive` is reserved and not offered.
    await expect(pane.getByLabel(/sensitive/i)).toHaveCount(0);

    // Criterion 5: from the field list, Tab reaches every control in order, then Apply.
    await pane.locator('[data-fields="choose"]').focus();
    for (const label of LABELS) {
      await page.keyboard.press('Tab');
      await expect(pane.getByLabel(label, { exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(pane.getByRole('button', { name: 'Apply' })).toBeFocused();

    // Each kind of control is operated from the keyboard: text, select, checkbox, text area.
    const seq = await confirmedSeq(page);
    await pane.getByLabel('Label', { exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Full name');
    await pane.getByLabel('Assignee (role)').focus();
    await page.keyboard.press('ArrowDown');
    await expect(pane.getByLabel('Assignee (role)')).toHaveValue('role_landlord');
    await pane.getByLabel('Required', { exact: true }).focus();
    await page.keyboard.press('Space');
    await pane.getByLabel('Placeholder', { exact: true }).focus();
    await page.keyboard.type('As in your passport');
    await pane.getByLabel('Validation (JSON object)').focus();
    await page.keyboard.type('{"minLength":2,"maxLength":40}');
    await pane.getByLabel('Width (points)').focus();
    await page.keyboard.type('120');
    await page.keyboard.press('Enter');

    // Criterion 3: the change is stored as one commit of attribute changes.
    await expect.poll(async () => (await attrs(page, FIELD_IDS.name))['label']).toBe('Full name');
    expect(await attrs(page, FIELD_IDS.name)).toMatchObject({
      key: 'tenant.name',
      label: 'Full name',
      assignee: 'role_landlord',
      required: false,
      placeholder: 'As in your passport',
      validation: { minLength: 2, maxLength: 40 },
      width: 2400,
      value: null,
    });
    expect(await confirmedSeq(page)).toBe(seq + 1);
    await expect(pane.locator('[data-status="apply"]')).toHaveText('');
    // The field in the document shows the new label as its accessible name.
    await expect(control(page, FIELD_IDS.name)).toHaveAttribute('aria-label', 'Full name');

    // One undo takes all of it back, as one more commit.
    await page.locator(`${EDITOR} .de-editing-surface p`).first().click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await attrs(page, FIELD_IDS.name))['label']).toBe('Name');
    expect(await attrs(page, FIELD_IDS.name)).toMatchObject({
      assignee: 'role_tenant',
      required: true,
      placeholder: null,
      validation: null,
      width: null,
    });
    await expect(pane.getByLabel('Label', { exact: true })).toHaveValue('Name');

    // An entry the document cannot hold: the reason is announced and nothing is committed.
    const before = await confirmedSeq(page);
    await pane.getByLabel('Key', { exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('tenant.email');
    await page.keyboard.press('Enter');
    const problems = pane.getByRole('alert');
    await expect(problems).toContainText('Key: Another field already uses this key.');
    await expect(pane.getByLabel('Key', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(pane.locator('[data-status="apply"]')).toHaveText(
      'Not applied. Fix the entries shown.',
    );
    expect(await confirmedSeq(page)).toBe(before);
    expect((await attrs(page, FIELD_IDS.name))['key']).toBe('tenant.name');

    // With the reasons shown. Not in Firefox: there axe on this state crashes the page of
    // Playwright's Firefox build ("Page crashed", no assertion reached), so it proves nothing.
    if (browserName !== 'firefox') expect(await axeViolations(page)).toEqual([]);

    // Another field is chosen from the list with the keyboard, and the panel shows it.
    await pane.locator('[data-fields="choose"]').focus();
    await page.keyboard.press('ArrowUp');
    await expect(pane.locator('[data-fields="choose"]')).toHaveValue(FIELD_IDS.amount);
    await expect(pane.getByLabel('Key', { exact: true })).toHaveValue('tenant.amount');
    await expect(pane.getByLabel('Kind', { exact: true })).toHaveValue('number');
    await expect(pane.getByLabel('Validation (JSON object)')).toHaveValue(
      '{"min":"0","max":"1000"}',
    );
  });

  test('the key, kind, options, default and format are edited in the pane, and each change is a commit of attributes (criteria 1 and 3)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'bob', role: 'editor' });
    await control(page, FIELD_IDS.name).click();
    await page.locator(`${EDITOR} .de-editing-surface p`).first().click();
    const pane = await openPane(page);
    await expect(pane.locator('[data-fields="choose"]')).toHaveValue(FIELD_IDS.name);
    const before = await confirmedSeq(page);

    // The text field becomes a choice: a new key, the options (one per line), a default that is
    // the identifier of an option, and a read-only flag.
    await pane.getByLabel('Key', { exact: true }).fill('tenant.status');
    await pane.getByLabel('Kind', { exact: true }).selectOption('choice');
    await pane
      .getByLabel('Options', { exact: true })
      .fill('opt_single | Single\nopt_married | Married');
    await pane.getByLabel('Default value').fill('opt_married');
    await pane.getByLabel('Read-only', { exact: true }).check();
    await pane.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => (await attrs(page, FIELD_IDS.name))['kind']).toBe('choice');
    expect(await attrs(page, FIELD_IDS.name)).toMatchObject({
      key: 'tenant.status',
      kind: 'choice',
      options: [
        { id: 'opt_single', label: 'Single' },
        { id: 'opt_married', label: 'Married' },
      ],
      default: 'opt_married',
      readOnly: true,
    });
    // One commit for all of it, and the log keeps what the field was before (the history of the
    // document: the content at the earlier sequence number).
    expect(await confirmedSeq(page)).toBe(before + 1);
    const earlier = await page.evaluate(
      async ({ seq }) => {
        const e = (
          window as unknown as {
            __embed: {
              service: {
                backend(
                  user: { sub: string },
                  docs: Record<string, string>,
                ): {
                  connect(): Promise<void>;
                  sync: { loadContent(id: string, seq: number): Promise<{ doc: unknown }> };
                };
              };
              fieldsDocId: string;
            };
          }
        ).__embed;
        const reader = e.service.backend({ sub: 'olga' }, { [e.fieldsDocId]: 'owner' });
        await reader.connect();
        return JSON.stringify((await reader.sync.loadContent(e.fieldsDocId, seq)).doc);
      },
      { seq: before },
    );
    expect(earlier).toContain('"key":"tenant.name"');
    expect(earlier).not.toContain('tenant.status');

    // A number field gets a display format: decimals and a suffix.
    await pane.locator('[data-fields="choose"]').selectOption(FIELD_IDS.amount);
    await expect(pane.getByLabel('Key', { exact: true })).toHaveValue('tenant.amount');
    await pane.getByLabel('Format (JSON object)').fill('{"decimals":2,"suffix":" EUR"}');
    await pane.getByRole('button', { name: 'Apply' }).click();
    await expect
      .poll(async () => (await attrs(page, FIELD_IDS.amount))['format'])
      .toEqual({ decimals: 2, suffix: ' EUR' });
    // The control of the number field shows the format, and the stored value stays as typed.
    await control(page, FIELD_IDS.amount).fill('7.5');
    await control(page, FIELD_IDS.amount).press('Tab');
    await expect(control(page, FIELD_IDS.amount)).toHaveValue('7.50 EUR');
    await expect.poll(async () => (await attrs(page, FIELD_IDS.amount))['value']).toBe('7.5');
  });

  test('a user without edit gets the pane read-only', async ({ page }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'vic', role: 'commenter' });
    const opened = await page.evaluate(() => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
          };
        }
      ).__embed;
      return e
        .internals(document.querySelector('doc-editor[data-test="one"]')!)
        .editor.openPane('fields');
    });
    expect(opened).toBe(true);
    const pane = page.locator(`${EDITOR} .de-pane[data-pane="fields"]`);
    await expect(pane.locator('[data-status="read-only"]')).toHaveText(
      'These properties cannot be changed now.',
    );
    for (const label of LABELS)
      await expect(pane.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(pane.getByRole('button', { name: 'Apply' })).toBeDisabled();
    // The properties are still shown.
    await expect(pane.getByLabel('Key', { exact: true })).toHaveValue('tenant.amount');
  });
});
