/**
 * The mini toolbar (UX-010; 13 §2, §4): near a selection the user may change it offers the common
 * formatting commands; it never takes the editing surface's focus or the pointer's press; Escape
 * and a collapsed selection dismiss it; a user who may not change the selection gets none.
 * Run with `DOCEDIT_UI_PORT=57250 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ux-010-mini-toolbar.spec.ts`.
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

const VIEW_ONLY = { scope: 'body', caps: ['view'], limit: 'role' } as const;

test.describe('the mini toolbar (UX-010)', () => {
  test('appears near a changeable selection with the common formatting commands', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    const mini = page.locator('[data-mini-toolbar]');
    await expect(mini).toBeVisible();
    await expect(mini.locator('[data-command-id="format.bold"]')).toBeVisible();
    await expect(mini.locator('[data-command-id="format.italic"]')).toBeVisible();
    // It runs the command it names, from the pointer.
    await mini.locator('[data-command-id="format.bold"]').click();
    expect(await h.runs()).toEqual(['bold']);
  });

  test('keeps the editing surface focused, and a collapsed selection dismisses it', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    await expect(page.locator('[data-mini-toolbar]')).toBeVisible();
    expect((await focused(page)).className).toContain('de-editing-surface');
    // Typing goes to the text, not to the toolbar: focus stays on the editing surface.
    await page.keyboard.type('x');
    expect((await focused(page)).className).toContain('de-editing-surface');
    await h.setSelection({ empty: true, marks: [] });
    await expect(page.locator('[data-mini-toolbar]')).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('Escape hides it first and leaves the text only on the next press', async ({ page }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    await expect(page.locator('[data-mini-toolbar]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-mini-toolbar]')).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
    // A new selection brings it back.
    await h.setSelection({ empty: true, marks: [] });
    // The shell clears the dismissal when it sees the collapse, which it does in a task of its own.
    // A reselection in the same task as the collapse is one change for it, not two.
    // WebKit on Linux needs more than one task for it (seen on the hosted runner), so two frames pass.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 0)));
    await h.frames(2);
    await h.setSelection({ empty: false, marks: [] });
    await expect(page.locator('[data-mini-toolbar]')).toBeVisible();
  });

  test('Alt+F10 moves focus into the toolbar, and Escape returns it to the selection', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    await expect(page.locator('[data-mini-toolbar]')).toBeVisible();
    await page.keyboard.press('Alt+F10');
    await expect(page.locator('[data-mini-toolbar] button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-mini-toolbar]')).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('is not offered where the user may not change the selection', async ({ page }) => {
    const h = await open(page, { extended: true, access: VIEW_ONLY });
    await focusSurface(page);
    await h.setSelection({ empty: false, marks: [] });
    await h.frames(2);
    await expect(page.locator('[data-mini-toolbar]')).toHaveCount(0);
  });
});
