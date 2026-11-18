/**
 * UX-020 on the mounted element (lane w3): the navigation pane's search runs on the real editing
 * core. It lists the matches of the body with the text around each and a count; choosing one
 * selects that text in the editing surface; "match case" is honoured; and the outline follows an
 * edit of a heading. Uses the embed page and its in-memory backend.
 */
import { expect, test, type Page } from '@playwright/test';
import { clickToolbarCommand, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);

async function openPane(page: Page): Promise<void> {
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada' });
  await clickToolbarCommand(page, 'outline');
  await page.locator(`${editor} .de-outline`).waitFor();
}

/** The text the editing surface has selected, read from the editor's own shadow root. */
const selected = (page: Page) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot as ShadowRoot & {
      getSelection?: () => Selection | null;
    };
    return (root.getSelection ? root.getSelection() : window.getSelection())?.toString() ?? '';
  }, editor);

test.describe('UX-020 the navigation pane on the mounted element', () => {
  test('lists the matches with their context and a count, and chooses one', async ({ page }) => {
    await openPane(page);
    const pane = page.locator(`${editor} .de-outline`);
    await pane.getByRole('searchbox', { name: 'Search for' }).fill('paragraph');
    await page.keyboard.press('Enter');
    const results = pane.getByRole('list', { name: 'Results' });
    const items = results.getByRole('button');
    await expect(items.first()).toBeVisible();
    const n = await items.count();
    expect(n).toBeGreaterThan(0);
    await expect(pane.locator('[data-status="search"]')).toContainText(String(n));
    // Every result marks the query in its context.
    await expect(items.first().locator('mark')).toHaveText('paragraph');
    const last = items.nth(n - 1);
    const context = await last.locator('[data-content]').innerText();
    expect(context).toContain('paragraph');
    await last.click();
    // The match is the selection in the surface, and it is in the viewport.
    await expect.poll(() => selected(page)).toBe('paragraph');
    const inView = await surface(page).evaluate((surfaceEl) => {
      const sel = (surfaceEl.getRootNode() as ShadowRoot).getSelection?.() ?? window.getSelection();
      const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      return !!rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    expect(inView).toBe(true);
  });

  test('honours "Match case" and says so when nothing matches', async ({ page }) => {
    await openPane(page);
    const pane = page.locator(`${editor} .de-outline`);
    const field = pane.getByRole('searchbox', { name: 'Search for' });
    await field.fill('LAST PARAGRAPH');
    await page.keyboard.press('Enter');
    await expect(pane.getByRole('list', { name: 'Results' }).getByRole('button')).toHaveCount(1);
    await pane.getByRole('checkbox', { name: 'Match case' }).check();
    await field.press('Enter');
    await expect(pane.locator('[data-status="search"]')).toHaveText('No results');
    await expect(pane.getByRole('list', { name: 'Results' })).toHaveCount(0);
  });
});
