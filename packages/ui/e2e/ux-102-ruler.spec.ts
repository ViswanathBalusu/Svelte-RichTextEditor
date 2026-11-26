/**
 * The ruler and the paragraph dialog in the shell (UX-102; lane w3, 2026-11-25), against the fake
 * core of the harness, which holds a paragraph format and applies `setParagraphFormat` as the
 * engine does. The real engine's side is packages/engine/test/ux-102-paragraph-format-info.test.ts
 * and the element's run is packages/element/e2e/ux-102-ruler.spec.ts.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-102-ruler`.
 */
import type { Page } from '@playwright/test';
import type { ParagraphFormatView } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const CM = 1440 / 2.54;

const format = (over: Partial<ParagraphFormatView> = {}): ParagraphFormatView => ({
  count: 1,
  indentLeft: Math.round(CM),
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [{ position: Math.round(5 * CM), align: 'left', leader: 'none' }],
  defaultTabStop: 720,
  page: { width: 11906, marginLeft: 1417, marginRight: 1417 },
  editable: true,
  ...over,
});

const marker = (page: Page, name: string) =>
  page.locator('.de-ruler').getByRole('slider', { name });

test.describe('the ruler (UX-102)', () => {
  test('shows the indents and the tab stops of the paragraph at the caret (criterion 1)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    const ruler = page.locator('.de-ruler');
    await expect(ruler).toBeVisible();
    await expect(marker(page, 'Left indent')).toHaveAttribute('aria-valuenow', '1');
    await expect(marker(page, 'First-line indent')).toHaveAttribute('aria-valuenow', '1');
    await expect(marker(page, 'Tab stop, Left')).toHaveAttribute('aria-valuenow', '5');
    // The caret moves to another paragraph: the markers follow.
    await h.setParagraphFormat(
      format({ indentLeft: 0, indentFirstLine: Math.round(2 * CM), tabs: [] }),
    );
    await expect(marker(page, 'Left indent')).toHaveAttribute('aria-valuenow', '0');
    await expect(marker(page, 'First-line indent')).toHaveAttribute('aria-valuenow', '2');
    await expect(marker(page, 'Tab stop, Left')).toHaveCount(0);
  });

  test('no ruler without a paragraph format from the core', async ({ page }) => {
    await open(page, { extended: true });
    await expect(page.locator('.de-ruler')).toHaveCount(0);
  });

  test('a drag on a marker runs setParagraphFormat (criterion 2)', async ({ page }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    const first = marker(page, 'First-line indent');
    const box = (await first.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // About one and a half centimetres to the right: 57 CSS pixels at the default zoom, on the quarter-cm grid.
    await page.mouse.move(x + 30, y, { steps: 4 });
    await page.mouse.move(x + 57, y, { steps: 4 });
    await page.mouse.up();
    const calls = (await h.named()).filter(([name]) => name === 'setParagraphFormat');
    expect(calls).toHaveLength(1);
    const patch = calls[0]![1] as { indentFirstLine?: number; indentLeft?: number };
    expect(patch.indentLeft).toBeUndefined();
    // Close to one and a half centimetres of first-line indent, to within one grid step either way.
    expect(patch.indentFirstLine!).toBeGreaterThan(Math.round(1.2 * CM));
    expect(patch.indentFirstLine!).toBeLessThan(Math.round(1.8 * CM));
    // The marker stands at the left indent (1 cm) plus that.
    await expect(first).toHaveAttribute('aria-valuenow', /^2\.[3-7]\d?$/);
  });

  test('a press on the bare ruler adds a tab stop, and Delete removes it', async ({ page }) => {
    const h = await open(page, { extended: true, paragraphFormat: format({ tabs: [] }) });
    const track = page.locator('.de-ruler-track');
    const box = (await track.boundingBox())!;
    // 3 cm in, on the lower half where no marker sits.
    await page.mouse.click(box.x + (3 * CM) / 15, box.y + 3);
    await expect(marker(page, 'Tab stop, Left')).toHaveCount(1);
    expect((await h.paragraphFormat())!.tabs).toHaveLength(1);
    await marker(page, 'Tab stop, Left').focus();
    await page.keyboard.press('Delete');
    await expect(marker(page, 'Tab stop, Left')).toHaveCount(0);
    expect((await h.paragraphFormat())!.tabs).toEqual([]);
  });

  test('every marker moves with the keyboard, through the same command (criterion 3)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    await marker(page, 'Left indent').focus();
    await page.keyboard.press('ArrowRight');
    const quarter = Math.round(1.25 * CM);
    await expect.poll(async () => (await h.paragraphFormat())!.indentLeft).toBe(quarter);
    await marker(page, 'Tab stop, Left').focus();
    await page.keyboard.press('PageUp');
    await expect
      .poll(async () => (await h.paragraphFormat())!.tabs![0]!.position)
      .toBe(Math.round(6 * CM));
    // Focus stays on the stop it moved.
    await expect(marker(page, 'Tab stop, Left')).toBeFocused();
    const calls = (await h.named()).filter(([name]) => name === 'setParagraphFormat');
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('the paragraph dialog sets the same values (criterion 3)', async ({ page }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paragraph' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Left indent (cm)').fill('2');
    await dialog.getByLabel('Tab stop 1: alignment').selectOption('right');
    await dialog.getByRole('button', { name: 'Add a tab stop' }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toHaveCount(0);
    const after = (await h.paragraphFormat())!;
    expect(after.indentLeft).toBe(Math.round(2 * CM));
    expect(after.tabs).toHaveLength(2);
    expect(after.tabs![0]!.align).toBe('right');
  });

  test('a length that is not a number is refused in the dialog', async ({ page }) => {
    const h = await open(page, { extended: true, paragraphFormat: format() });
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paragraph' });
    await dialog.getByLabel('Left indent (cm)').fill('wide');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('Left indent (cm)')).toHaveAttribute('aria-invalid', 'true');
    expect((await h.named()).filter(([n]) => n === 'setParagraphFormat')).toHaveLength(0);
  });

  test('the web view says the margins are the PDF’s and shows no pages (criterion 4)', async ({
    page,
  }) => {
    await open(page, { extended: true, paragraphFormat: format() });
    const note = page.locator('.de-ruler-note');
    await expect(note).toContainText(
      'The PDF has margins of 2.5 cm on the left and 2.5 cm on the right',
    );
    await expect(page.locator('.de-ruler [data-page], .de-ruler [class*="page"]')).toHaveCount(0);
  });

  test('a paragraph the user may not change gives a ruler that does not move it', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, paragraphFormat: format({ editable: false }) });
    await expect(marker(page, 'Left indent')).toHaveAttribute('aria-disabled', 'true');
    await marker(page, 'Left indent').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Paragraph…' })).toBeDisabled();
    expect((await h.named()).filter(([n]) => n === 'setParagraphFormat')).toHaveLength(0);
  });

  test('the host styles the ruler through its part and nothing else (criterion 5)', async ({
    page,
  }) => {
    await open(page, { extended: true, paragraphFormat: format() });
    await expect(page.locator('.de-ruler')).toHaveAttribute('part', 'ruler');
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.insertRule('#host::part(ruler) { outline: 3px solid rgb(1, 2, 3); }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    const outline = await page
      .locator('.de-ruler')
      .evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outline).toBe('rgb(1, 2, 3)');
    // The ruler's own colours come from `--de-` properties of the shell.
    const css = await page.evaluate(async () => {
      const text: string[] = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) text.push(rule.cssText);
        } catch {
          /* a sheet of another origin */
        }
      }
      return text.filter((t) => t.includes('.de-ruler')).join('\n');
    });
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test('has no axe violations, with the dialog open too', async ({ page }) => {
    await open(page, { extended: true, paragraphFormat: format() });
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Paragraph…' }).click();
    await expect(page.getByRole('dialog', { name: 'Paragraph' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
