/**
 * The mention picker in the comment box, by keyboard alone (UX-031 criterion 5, the keyboard and
 * announcement part). Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-031-mention-keyboard.spec.ts`.
 * The fragment `o` matches two harness principals, Ada Lovelace and Grace Hopper, in that order.
 * The criterion's "standard combobox" role is not claimed here: the field is a multi-line textarea.
 */
import { expect, open, test } from './helpers.ts';

test.describe('mention picker by keyboard (UX-031, criterion 5)', () => {
  test('ArrowDown moves through the results, Enter chooses, and the count is announced', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    const field = box.getByRole('textbox', { name: 'Comment' });

    await field.focus();
    await field.pressSequentially('@o');
    const options = box.getByRole('option');
    await expect(options).toHaveText([/Ada Lovelace/, /Grace Hopper/]);
    await expect(field).toHaveAttribute('aria-activedescendant', /-mention-0$/);

    // The count is announced in the shell's live region.
    await expect(page.locator('.de-shell [role="status"]').last()).toHaveText(
      '2 people or groups found.',
    );

    await field.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', /-mention-1$/);
    await field.press('ArrowUp');
    await expect(field).toHaveAttribute('aria-activedescendant', /-mention-0$/);
    await field.press('ArrowDown');

    await field.press('Enter');
    await expect(field).toHaveValue('@Grace Hopper ');
    await expect(box.getByRole('listbox')).toBeHidden();
    await expect(box).toBeVisible();
  });

  test('Escape closes the list and keeps the dialog and the typed text', async ({ page }) => {
    const h = await open(page, { extended: true, comments: true });
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    const field = box.getByRole('textbox', { name: 'Comment' });

    await field.focus();
    await field.pressSequentially('@o');
    await expect(box.getByRole('option')).toHaveCount(2);
    await field.press('Escape');
    await expect(box.getByRole('listbox')).toBeHidden();
    await expect(box).toBeVisible();
    await expect(field).toHaveValue('@o');
  });
});
