/**
 * FE-129 criterion 6 in the shell: the paragraph dialog reaches every option of the paragraph
 * format from the keyboard (02 §10; UX-102), against the fake core of the harness. The real
 * engine's side is packages/engine/test/fe-129-paragraph-options-info.test.ts and the element's
 * run is packages/element/e2e/fe-129-paragraph-dialog.spec.ts.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts fe-129-paragraph-dialog`.
 */
import type { Page } from '@playwright/test';
import type { ParagraphFormatView } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const format = (): ParagraphFormatView => ({
  count: 1,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [],
  defaultTabStop: 720,
  page: { width: 11906, marginLeft: 1417, marginRight: 1417 },
  editable: true,
  options: {
    align: 'start',
    spaceBefore: 0,
    spaceAfter: 0,
    lineSpacing: 1000,
    lineRule: 'multiple',
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: true,
    contextualSpacing: false,
    borders: {},
    shading: null,
    mixed: [],
  },
});

/** The names, in order, of the controls that Tab reaches inside the dialog. */
async function tabOrder(page: Page): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < 80; i++) {
    const name = await page.evaluate(() => {
      const el = document.activeElement?.shadowRoot?.activeElement ?? document.activeElement;
      return el
        ? (
            el.getAttribute('aria-label') ??
            (el as HTMLInputElement).labels?.[0]?.textContent ??
            el.textContent ??
            ''
          ).trim()
        : '';
    });
    if (names.includes(name) && name !== '') break;
    names.push(name);
    await page.keyboard.press('Tab');
  }
  return names;
}

test.describe('the paragraph dialog reaches every option from the keyboard (FE-129 criterion 6)', () => {
  test('Tab visits alignment, indents, spacing, line spacing, tab stops, keep rules, borders and shading', async ({
    page,
  }) => {
    await open(page, { extended: true, paragraphFormat: format() });
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paragraph' });
    await expect(dialog).toBeVisible();
    const names = await tabOrder(page);
    const expected = [
      'Left indent (cm)',
      'Right indent (cm)',
      'First-line indent (cm; negative for a hanging indent)',
      'Alignment',
      'Space before (pt)',
      'Space after (pt)',
      'Line spacing rule',
      'Line spacing (lines)',
      'Add a tab stop',
      'Keep with next paragraph',
      'Keep lines together',
      'Page break before',
      'Widow and orphan control',
      'No space between paragraphs of the same style',
      'Top border: style',
      'Top border: width (pt)',
      'Top border: colour (#RRGGBB, blank for automatic)',
      'Top border: distance from the text (pt)',
      'Bottom border: style',
      'Left border: style',
      'Right border: style',
      'Between paragraphs border: style',
      'Shading colour (#RRGGBB, blank for none)',
      'Apply',
      'Cancel',
    ];
    for (const name of expected) expect(names, name).toContain(name);
    // In the order of the dialog: each control comes after the one before it.
    const at = expected.map((n) => names.indexOf(n));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  test('every option can be set with the keyboard alone, and Enter applies', async ({ page }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paragraph' });
    await expect(dialog).toBeVisible();
    const press = (key: string, times = 1) =>
      page.keyboard.press(key, { delay: 0 }).then(async () => {
        for (let i = 1; i < times; i++) await page.keyboard.press(key);
      });
    // Alignment: a letter picks the option that starts with it.
    await dialog.getByLabel('Alignment').focus();
    await page.keyboard.type('J');
    // Spacing and line spacing.
    await dialog.getByLabel('Space before (pt)').focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('6');
    await press('Tab');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('12');
    await press('Tab');
    await page.keyboard.type('E'); // the rule "Exactly"
    await press('Tab');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('14');
    // Keep rules: Space toggles a check box.
    await dialog.getByLabel('Keep with next paragraph').focus();
    await press('Space');
    await dialog.getByLabel('Widow and orphan control').focus();
    await press('Space');
    // A border and the shading.
    await dialog.getByLabel('Top border: style').focus();
    await page.keyboard.type('S');
    await press('Tab');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0.5');
    await press('Tab');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('#ff0000');
    await dialog.getByLabel('Shading colour (#RRGGBB, blank for none)').focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('#FFF2CC');
    await press('Enter');
    await expect(dialog).toHaveCount(0);
    const calls = (await h.named()).filter(([name]) => name === 'setParagraphFormat');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({
      align: 'justify',
      spaceBefore: 120,
      spaceAfter: 240,
      lineRule: 'exact',
      lineSpacing: 280,
      keepNext: true,
      widowControl: false,
      borders: { top: { style: 'single', width: 4, color: '#FF0000' } },
      shading: { fill: '#FFF2CC' },
    });
    // The dialog shows the stored values when it opens again.
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    const again = page.getByRole('dialog', { name: 'Paragraph' });
    await expect(again.getByLabel('Alignment')).toHaveValue('justify');
    await expect(again.getByLabel('Keep with next paragraph')).toBeChecked();
    await expect(again.getByLabel('Widow and orphan control')).not.toBeChecked();
    await expect(again.getByLabel('Shading colour (#RRGGBB, blank for none)')).toHaveValue(
      '#FFF2CC',
    );
  });

  test('refuses a colour that is not #RRGGBB, names the field, and has no axe violations', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paragraph' });
    await dialog.getByLabel('Shading colour (#RRGGBB, blank for none)').fill('red');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('Shading colour (#RRGGBB, blank for none)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect((await h.named()).filter(([n]) => n === 'setParagraphFormat')).toHaveLength(0);
    expect(await axe(page)).toEqual([]);
  });
});
