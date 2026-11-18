/**
 * Commenting where the content is frozen (UX-028 criterion 4). The document is locked or archived,
 * a region is approved, or a workflow freezes the content: the access view says `edit` is missing
 * and why, and the comment command still runs, because it asks for `comment` in the scopes it
 * covers and nothing else. The thread request is a control-plane request: no command of the core
 * runs and nothing is committed. The same limit keeps an editing command disabled, so the test
 * shows the limit is in force when the comment goes through.
 *
 * Shell level, with the harness core as the other tests of UX-028 (the element has no threads port
 * yet, so the service's own answer under a lock is not run here).
 */
import { expect, open, test } from './helpers.ts';

const BLOCK = { selection: { kind: 'block', id: 'fig1' }, scopes: [['view', 'comment']] } as const;
const LIMITS = ['locked', 'archived', 'approved', 'workflow'] as const;

test.describe('commenting where the content is frozen (UX-028 criterion 4)', () => {
  for (const limit of LIMITS) {
    test(`with the limit '${limit}' the comment command runs and no command of the core does`, async ({
      page,
    }) => {
      const h = await open(page, { extended: true, comments: true });
      await h.setThreadAnchor(BLOCK);
      await h.setAccess({ scope: 'body', caps: ['view', 'comment'], limit });
      await h.frames(2);
      // The limit is in force: an editing command is disabled for it.
      expect(await h.state('format.bold')).toMatchObject({ enabled: false });
      // Commenting is still allowed.
      expect(await h.state('review.comment')).toMatchObject({ offered: true, enabled: true });
      expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
      const box = page.locator('[data-dialog="comment"]');
      await expect(box).toBeVisible();
      await box.getByRole('textbox', { name: 'Comment' }).fill(`Noted while ${limit}.`);
      await box.getByRole('button', { name: 'Post' }).click();
      await expect(box).toBeHidden();
      expect(await h.threadRequests()).toEqual([
        { target: { block: 'fig1' }, body: [{ type: 'text', text: `Noted while ${limit}.` }] },
      ]);
      expect(await h.runs()).toEqual([]);
      expect(await h.named()).toEqual([]);
      await expect(page.locator('.de-shell [role="status"]').last()).toHaveText('Comment added.');
    });
  }
});
