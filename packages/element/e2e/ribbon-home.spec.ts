/**
 * The ribbon's Home tab in the real `<doc-editor>` (ADR 0490): each button runs the core's own
 * command and changes the document, not only a stand-in's record of the call. Underline, a font
 * size and a text colour from the lists, centring, and the first bulleted list of a document that
 * has no numbering definition (the core adds one in the same step). The owner role is used, because
 * adding a definition needs the right to change the document's structure (07 §7).
 *
 * The embed page with the in-memory backend (`pages/embed.html`). Run with `DOCEDIT_DEMO_PORT=56553
 * pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/ribbon-home.spec.ts --project=chromium`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface Methods {
  getContent(): Promise<{ doc: unknown }>;
  flush(options: { timeoutMs: number }): Promise<void>;
}

/** The document as JSON, once the changes are saved. */
async function saved(page: Page): Promise<string> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(sel) as unknown as Methods;
    await el.flush({ timeoutMs: 10_000 });
    return JSON.stringify((await el.getContent()).doc);
  }, editor);
}

/** Selects the last paragraph's text, from its end back to its start. */
async function selectLastParagraph(page: Page): Promise<void> {
  const paragraph = page
    .locator(`${editor} .de-editing-surface`)
    .locator('p', { hasText: 'Last paragraph.' });
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
}

test.describe('the Home tab of the ribbon changes the document', () => {
  test.beforeEach(async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { sub: 'ada', role: 'owner', attributes: { toolbar: 'ribbon' } });
    // The Home commands beyond bold and italic load a moment after the editor.
    await expect(
      page.locator(`${editor} button[data-command-id="format.underline"]`),
    ).toBeVisible();
  });

  const button = (page: Page, name: string) =>
    page.locator(editor).getByRole('button', { name, exact: true });

  test('Underline puts the underline mark on the selected text and shows as pressed', async ({
    page,
  }) => {
    await selectLastParagraph(page);
    expect(await saved(page)).not.toContain('"type":"underline"');
    await button(page, 'Underline').click();
    await expect(button(page, 'Underline')).toHaveAttribute('aria-pressed', 'true');
    expect(await saved(page)).toContain('"type":"underline"');
    await button(page, 'Underline').click();
    await expect(button(page, 'Underline')).toHaveAttribute('aria-pressed', 'false');
  });

  test('the size and colour lists set a size and a colour of the model', async ({ page }) => {
    await selectLastParagraph(page);
    await page.locator(`${editor} button[data-command-id="format.fontSize"]`).click();
    await page.getByRole('menuitemradio', { name: '18', exact: true }).click();
    await button(page, 'Text colour').click();
    await page.getByRole('menuitem', { name: 'Dark red' }).click();
    const doc = await saved(page);
    expect(doc).toContain('"type":"fontSize"');
    expect(doc).toContain('"value":360');
    expect(doc).toContain('#A4262C');
    await expect(
      page.locator(`${editor} button[data-command-id="format.fontSize"]`),
    ).toHaveAccessibleName('Font size: 18');
  });

  test('Centre sets the alignment of the paragraph and shows as pressed', async ({ page }) => {
    await selectLastParagraph(page);
    await expect(button(page, 'Align start')).toHaveAttribute('aria-pressed', 'true');
    await button(page, 'Centre').click();
    await expect(button(page, 'Centre')).toHaveAttribute('aria-pressed', 'true');
    await expect(button(page, 'Align start')).toHaveAttribute('aria-pressed', 'false');
    expect(await saved(page)).toContain('"align":"center"');
  });

  test('Bulleted list makes the first definition and the list in one step, and toggles off', async ({
    page,
  }) => {
    await selectLastParagraph(page);
    expect(await saved(page)).not.toContain('numbering_def');
    await button(page, 'Bulleted list').click();
    const on = await saved(page);
    expect(on).toContain('numbering_def');
    expect(on).toContain('"bulletChar"');
    expect(on).toContain('"listId"');
    await button(page, 'Bulleted list').click();
    expect(await saved(page)).not.toContain('"listId"');
  });
});
