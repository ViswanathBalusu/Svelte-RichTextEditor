/**
 * The thread limit in the comment box (PRM-040 criterion 2, lane U-PRM-035-051): when a document
 * has the largest number of threads, starting one shows the reason, keeps the typed text and sends
 * nothing. The limit is checked in the box first (`threadLimitGate`, 5,000 threads) and again by
 * the service, which refuses with `quota_exceeded` (05 §5.8); both show the same explanation.
 */
import { axe, expect, open, test } from './helpers.ts';

const LIMIT_TEXT =
  'This document already has the largest number of comment threads it may have. Nothing was added; your text is kept.';

const BLOCK = { selection: { kind: 'block', id: 'fig1' }, scopes: [['view', 'comment']] } as const;

test.describe('the thread limit in the comment box (PRM-040 criterion 2)', () => {
  test('at 5,000 threads the box explains why, keeps the text and sends nothing', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.setThreadAnchor(BLOCK);
    await h.setThreadCount(5000);
    await h.frames(2);
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    const field = box.getByRole('textbox', { name: 'Comment' });
    await field.fill('One more point.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box.getByRole('alert')).toHaveText(LIMIT_TEXT);
    await expect(field).toHaveValue('One more point.');
    await expect(box).toBeVisible();
    expect(await h.threadRequests()).toEqual([]);
    expect(await axe(page)).toEqual([]);
  });

  test('at 4,999 threads the box still posts the thread (the limit is not reached early)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.setThreadAnchor(BLOCK);
    await h.setThreadCount(4999);
    await h.frames(2);
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    await box.getByRole('textbox', { name: 'Comment' }).fill('The last one.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    expect(await h.threadRequests()).toEqual([
      { target: { block: 'fig1' }, body: [{ type: 'text', text: 'The last one.' }] },
    ]);
  });

  test('a refusal by the service with quota_exceeded gives the same explanation', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.setThreadAnchor(BLOCK);
    await h.frames(2);
    await h.refuseNextThread('quota_exceeded');
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    const field = box.getByRole('textbox', { name: 'Comment' });
    await field.fill('Please keep this.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box.getByRole('alert')).toHaveText(LIMIT_TEXT);
    await expect(field).toHaveValue('Please keep this.');
  });
});
