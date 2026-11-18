/**
 * Choosing how suggestions are shown (UX-035; 13 §5), in the shell. The four markup views are
 * commands of the registry (`review.markup.all`, `.simple`, `.none`, `.original`), reached by
 * command search and `exec`. Choosing one asks the core for that view and nothing else: no named
 * command runs and no content command is sent (criterion 2). The shell also gives the core the words
 * that name a suggestion for assistive technology, with the host's names (criterion 4). How each
 * view is drawn is checked against the real body view in
 * packages/engine/src/view/ux-035-markup-view.universal.test.ts.
 * Run with `DOCEDIT_UI_PORT=57332 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ux-035-markup-views.spec.ts`.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

test.describe('markup views of suggestions (UX-035)', () => {
  test('command search lists the four views, and choosing one asks the core for it and runs no content command', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, markupViews: true });
    expect(await h.markupView()).toBe('all');
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('markup');
    const list = page.getByRole('listbox');
    for (const view of ['all', 'simple', 'none', 'original'])
      await expect(list.locator(`[data-command-id="review.markup.${view}"]`)).toBeVisible();

    await list.locator('[data-command-id="review.markup.simple"]').click();
    expect(await h.markupView()).toBe('simple');
    expect(await h.callsOf('setMarkupView')).toEqual([['simple']]);
    // Nothing that edits ran: no named command and no core command.
    expect(await h.runs()).toEqual([]);
    expect(await h.named()).toEqual([]);

    await page.keyboard.press('Alt+q');
    await page.keyboard.type('original');
    await page.getByRole('listbox').locator('[data-command-id="review.markup.original"]').click();
    expect(await h.markupView()).toBe('original');
    expect(await h.runs()).toEqual([]);
  });

  test('exec chooses a view, as a host button would', async ({ page }) => {
    const h = await open(page, { extended: true, markupViews: true });
    expect((await h.exec('review.markup.none')).ran).toBe(true);
    expect(await h.markupView()).toBe('none');
  });

  test('a core without markup views offers no such command', async ({ page }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await page.keyboard.press('Alt+q');
    await page.keyboard.type('markup');
    await expect(page.getByText('No results')).toBeVisible();
    expect(await h.callsOf('setMarkupView')).toEqual([]);
  });

  test('names a suggestion for assistive technology with the host name of its author', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, markupViews: true });
    // Before the directory answers, the neutral label; then the host's name for the same identifier.
    await expect.poll(() => h.suggestionLabel('ins', 'u1')).toBe('Inserted by Ada Lovelace');
    expect(await h.suggestionLabel('del', 'u2')).toMatch(/^Deleted by /);
    await expect.poll(() => h.suggestionLabel('del', 'u2')).toBe('Deleted by Grace Hopper');
    await expect
      .poll(() => h.suggestionLabel('fmt', 'u1'))
      .toBe('Formatting changed by Ada Lovelace');
  });
});
