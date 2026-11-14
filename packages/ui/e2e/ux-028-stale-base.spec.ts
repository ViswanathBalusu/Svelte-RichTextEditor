/**
 * UX-028 criterion 3, second refusal (lane V-UX-016-030): the service refuses a thread whose `baseSeq`
 * is outside the rebase window. The typed text is kept and the reason is shown. The permission
 * refusal is in comments.spec.ts.
 */
import { expect, open, test } from './helpers.ts';

test.describe('a refused comment keeps the text (UX-028 criterion 3)', () => {
  test('a baseSeq outside the rebase window keeps the typed text and shows the reason', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.refuseNextThread('stale_base');
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    const field = box.getByRole('textbox', { name: 'Comment' });
    await field.fill('Please keep this too.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box.getByRole('alert')).toHaveText(
      'The document changed too much since you made the selection. Select the text again; your text is kept.',
    );
    await expect(field).toHaveValue('Please keep this too.');
    // The refused request was sent once; the fake records a thread only when it is accepted.
    expect(await h.threadRequests()).toHaveLength(1);
  });
});
