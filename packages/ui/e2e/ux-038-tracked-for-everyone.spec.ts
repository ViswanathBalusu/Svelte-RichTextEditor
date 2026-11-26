/**
 * "Tracked changes for everyone" in the mode switcher (UX-038 criteria 1 and 3, the display and the
 * live change; 13 §5; 07 §5.2). Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-038-tracked-for-everyone.spec.ts`.
 * The harness is the fake core: the setting is the host's `setTrackedForEveryone`, which stands for
 * `settings.trackChanges` changing in the document. The server's refusal of a direct change is
 * covered by packages/authority/test/suggestions.test.ts (PRM-015), not here.
 */
import { axe, expect, open, test } from './helpers.ts';

const REASON = 'Tracked changes are on for everyone, so your edits are recorded as suggestions.';

test.describe('tracked changes for everyone in the mode switcher (UX-038)', () => {
  test('editors see review mode with the reason while the setting is on', async ({ page }) => {
    await open(page, {
      extended: true,
      modes: ['edit', 'review', 'view'],
      mode: 'edit',
      trackedForEveryone: true,
    });
    const button = page.locator('.de-mode-button');
    await expect(button).toHaveAccessibleName('Mode: Reviewing');
    await expect(button).toHaveAttribute('data-mode', 'review');
    await expect(page.locator('.de-mode-reason')).toHaveText(REASON);

    await button.click();
    const menu = page.getByRole('menu', { name: 'Modes' });
    await expect(menu.getByRole('menuitemradio', { name: 'Reviewing' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(menu.getByRole('menuitemradio', { name: 'Editing' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(await axe(page)).toEqual([]);
  });

  test('turning the setting off and on again changes the mode without a reload', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      modes: ['edit', 'review', 'view'],
      mode: 'edit',
      trackedForEveryone: true,
    });
    // A marker on the window: it is lost if the page reloads.
    await page.evaluate(() => {
      (window as unknown as { marker: number }).marker = 7;
    });
    const button = page.locator('.de-mode-button');
    await expect(button).toHaveAccessibleName('Mode: Reviewing');

    await h.setTrackedForEveryone(false);
    await expect(button).toHaveAccessibleName('Mode: Editing');
    await expect(page.locator('.de-mode-reason')).toHaveCount(0);

    await h.setTrackedForEveryone(true);
    await expect(button).toHaveAccessibleName('Mode: Reviewing');
    await expect(page.locator('.de-mode-reason')).toHaveText(REASON);

    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(7);
  });

  test('a mode other than editing is shown as it is, with no reason', async ({ page }) => {
    await open(page, {
      extended: true,
      modes: ['edit', 'review', 'view'],
      mode: 'view',
      trackedForEveryone: true,
    });
    await expect(page.locator('.de-mode-button')).toHaveAccessibleName('Mode: Viewing');
    await expect(page.locator('.de-mode-reason')).toHaveCount(0);
  });
});

const MANAGE = {
  scope: 'body',
  caps: ['view', 'comment', 'suggest', 'edit', 'manage'] as Array<
    'view' | 'comment' | 'suggest' | 'edit' | 'manage'
  >,
};
const EDITOR = { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'] as const };

test.describe('the setting in the review pane (UX-038 criteria 1, 2, 3 and 5)', () => {
  test('a user with manage turns it on and off, and the mode follows with the reason (criteria 1 and 3)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      review: true,
      modes: ['edit', 'review', 'view'],
      mode: 'edit',
      trackedForEveryone: false,
      access: MANAGE,
    });
    expect(await h.exec('view.review')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="review"]');
    const box = pane.getByRole('checkbox', { name: 'Track changes for everyone' });
    await expect(pane.locator('[data-tracked-state]')).toContainText('are off');
    await expect(box).not.toBeChecked();
    await expect(page.locator('.de-mode-button')).toHaveAttribute('data-mode', 'edit');

    await box.check();
    await expect(pane.locator('[data-tracked-state]')).toContainText('are on');
    await expect(page.locator('.de-mode-button')).toHaveAttribute('data-mode', 'review');
    await expect(page.locator('.de-mode-reason')).toHaveText(REASON);
    expect((await h.named()).filter(([n]) => n === 'setTrackedForEveryone')).toEqual([
      ['setTrackedForEveryone', { on: true }],
    ]);

    // Off again: the same page, no reload, editors edit directly (the mode returns to edit).
    await box.uncheck();
    await expect(pane.locator('[data-tracked-state]')).toContainText('are off');
    await expect(page.locator('.de-mode-button')).toHaveAttribute('data-mode', 'edit');
  });

  test('without manage the control is not offered, and the pane says who may switch it off (criteria 2 and 5)', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      review: true,
      modes: ['edit', 'review', 'view'],
      mode: 'edit',
      trackedForEveryone: true,
      access: { scope: 'body', caps: [...EDITOR.caps] },
    });
    expect(await h.exec('view.review')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="review"]');
    await expect(pane.locator('[data-tracked-state]')).toContainText('are on');
    await expect(pane.locator('[data-tracked-who]')).toContainText('right to manage');
    await expect(pane.getByRole('checkbox', { name: 'Track changes for everyone' })).toHaveCount(0);
    // The setting turned off elsewhere reaches this page as it is: the note about who may switch it off goes.
    await h.setTrackedForEveryone(false);
    await expect(pane.locator('[data-tracked-who]')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });
});
