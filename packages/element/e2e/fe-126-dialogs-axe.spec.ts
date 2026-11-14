/**
 * FE-126 criterion 1, dialogs (lane V-FE-113-128): axe, run through the shadow roots, on the
 * editor with a shell dialog open. The fe-126-axe-states spec covers the S1 page, which has no
 * shell dialog; this spec mounts the element on the embed page (the shell with its header) and
 * opens the language dialog (command `format.language`, from the shell's own button, or from the
 * command search when no button is shown). The check is the FE-019 comparison: the dialog state
 * must not add an axe rule that the editing state does not report, and must not grow the node
 * count of a rule that it does. Chromium only (time budget). Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-126-dialogs-axe.spec.ts --project=chromium`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';
import { record } from './helpers.ts';

type Summary = Map<string, number>;

async function summarise(page: Page): Promise<Summary> {
  const results = await new AxeBuilder({ page }).analyze();
  const summary: Summary = new Map();
  for (const v of results.violations) summary.set(v.id, v.nodes.length);
  return summary;
}

/**
 * Opens the language dialog (command `format.language`) through the command search (Alt+Q, the
 * shell's `view.commandSearch`). The toolbar's "More" menu lists view commands only, and the
 * context menu of a selection does not list this command on the embed page.
 */
async function openLanguageDialog(page: Page): Promise<void> {
  const editor = page.locator('doc-editor[data-test="one"]');
  const surface = editor.locator('.de-editing-surface').first();
  await surface.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Alt+q');
  const search = editor.locator('input[role="combobox"]').first();
  await expect(search).toBeVisible();
  await search.fill('language');
  await page.keyboard.press('Enter');
  await expect(editor.locator('[role="dialog"], dialog[open]').first()).toBeVisible();
}

test.describe('FE-126 dialogs: axe finds nothing new with a shell dialog open', () => {
  test('the language dialog adds no axe rule and grows no rule', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'axe is run in Chromium only (time budget)');
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(page.locator('doc-editor[data-test="one"] .de-editing-surface')).toHaveAttribute(
      'contenteditable',
      'true',
    );

    const editing = await summarise(page);
    await openLanguageDialog(page);
    const dialog = await summarise(page);

    const added = [...dialog.keys()].filter((id) => !editing.has(id));
    const grew = [...dialog.keys()].filter(
      (id) => editing.has(id) && dialog.get(id)! > editing.get(id)!,
    );
    record('fe-126-dialog-language', {
      editing: Object.fromEntries(editing),
      dialog: Object.fromEntries(dialog),
      added,
      grew,
    });
    expect({ added, grew }).toEqual({ added: [], grew: [] });
  });
});
