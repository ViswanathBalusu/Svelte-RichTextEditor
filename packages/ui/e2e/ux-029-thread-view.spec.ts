/**
 * The thread view in the comments pane (UX-029 criteria 1, 2, 3, 4 (view half), 5 and 6). The
 * threads and their comments come from the harness's threads port, the service's copy of each one
 * with a version; a write sends the version and the port answers as the service would. The shell
 * level, with the harness core: the element has no threads port yet (see the story's Notes).
 */
import type { Page } from '@playwright/test';
import type { ThreadDetail, ThreadSummary } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const SUMMARIES: ThreadSummary[] = [
  {
    id: 't1',
    position: 10,
    state: 'open',
    author: 'user:ada',
    createdAt: '2026-11-01T09:00:00Z',
    replyCount: 1,
    assignee: null,
    target: { range: { from: 3, to: 12, baseSeq: 41 } },
    excerpt: 'Check this sentence.',
    blockKind: null,
  },
];

const T1: Omit<ThreadDetail, 'etag'> = {
  id: 't1',
  state: 'open',
  author: 'user:ada',
  detached: false,
  caps: ['view', 'comment'],
  comments: [
    {
      id: 'c1',
      author: 'user:ada',
      createdAt: '2026-11-01T09:00:00Z',
      body: [{ type: 'text', text: 'Is this right?' }],
      edited: false,
    },
    {
      id: 'c2',
      author: 'user:grace',
      createdAt: '2026-11-01T09:30:00Z',
      body: [{ type: 'text', text: 'Yes, I checked.' }],
      edited: false,
    },
  ],
};

async function openThread(
  page: Page,
  detail: Omit<ThreadDetail, 'etag'> = T1,
  user = 'user:ada',
  summaries: ThreadSummary[] = SUMMARIES,
) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  await h.setThreads(summaries);
  await h.putThreads([detail]);
  await h.setThreadUser(user);
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await expect(pane).toBeVisible();
  await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
  const view = pane.locator('[data-thread-view="t1"]');
  await expect(view).toBeVisible();
  return { h, pane, view };
}

const texts = (view: ReturnType<Page['locator']>) =>
  view.locator('[data-comment] .de-comment-text').allTextContents();

test.describe('the thread view (UX-029)', () => {
  test('a reply from another client appears without a reload, and a reply of mine is sent with the version (criterion 1)', async ({
    page,
  }) => {
    const { h, view } = await openThread(page);
    expect(await texts(view)).toEqual(['Is this right?', 'Yes, I checked.']);
    await h.remoteReply('t1', 'user:alan', 'I agree with Grace.');
    await expect(view.locator('[data-comment] .de-comment-text')).toHaveCount(3);
    expect(await texts(view)).toEqual(['Is this right?', 'Yes, I checked.', 'I agree with Grace.']);
    await view.getByRole('textbox', { name: 'Reply' }).fill('Thanks both.');
    await view.getByRole('button', { name: 'Post reply' }).click();
    await expect(view.locator('[data-comment] .de-comment-text')).toHaveCount(4);
    expect((await texts(view)).at(-1)).toBe('Thanks both.');
    await expect(view.getByRole('textbox', { name: 'Reply' })).toHaveValue('');
    const writes = (await h.threadWrites()) as Array<{ op: string; etag: string }>;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      op: 'reply',
      id: 't1',
      body: [{ type: 'text', text: 'Thanks both.' }],
    });
    // The version sent is the one that was current, which the remote reply had moved on.
    expect(writes[0]!.etag).toMatch(/^v\d+$/);
    await expect(page.locator('.de-shell [role="status"]').last()).toHaveText('Reply added.');
  });

  test('edit and delete are offered to the author of a comment, or to manage, and a thread is deleted by its author or manage (criterion 2)', async ({
    page,
  }) => {
    // Ada wrote the thread and c1: she may edit and delete c1, not Grace's c2, and delete the thread.
    const { view } = await openThread(page);
    const c1 = view.locator('[data-comment="c1"]');
    const c2 = view.locator('[data-comment="c2"]');
    await expect(c1.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(c1.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(c2.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(c2.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(view.getByRole('button', { name: 'Delete thread' })).toBeVisible();
  });

  test('another user without manage may do none of it, and a user with manage may do all of it (criterion 2)', async ({
    page,
  }) => {
    const other = await openThread(page, T1, 'user:alan');
    await expect(other.view.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(other.view.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect(other.view.getByRole('button', { name: 'Delete thread' })).toHaveCount(0);
    // Replying is still allowed with `comment`.
    await expect(other.view.getByRole('textbox', { name: 'Reply' })).toBeEnabled();

    const manager = await openThread(
      page,
      { ...T1, caps: ['view', 'comment', 'manage'] },
      'user:alan',
    );
    await expect(manager.view.getByRole('button', { name: 'Edit' })).toHaveCount(2);
    await expect(manager.view.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(2);
    await expect(manager.view.getByRole('button', { name: 'Delete thread' })).toBeVisible();
  });

  test('an author edits and deletes a comment, and deletes the thread', async ({ page }) => {
    const { h, pane, view } = await openThread(page);
    await view.locator('[data-comment="c1"]').getByRole('button', { name: 'Edit' }).click();
    await view.getByRole('textbox', { name: 'Edit comment by ada' }).fill('Is this correct?');
    await view.getByRole('button', { name: 'Save' }).click();
    await expect(view.locator('[data-comment="c1"] .de-comment-text')).toHaveText(
      'Is this correct?',
    );
    await expect(view.locator('[data-comment="c1"]')).toContainText('edited');
    await view.locator('[data-comment="c1"]').getByRole('button', { name: 'Delete' }).click();
    await expect(view.locator('[data-comment="c1"]')).toHaveCount(0);
    await view.getByRole('button', { name: 'Delete thread' }).click();
    await expect(pane.locator('[data-thread-view]')).toHaveCount(0);
    await expect(pane.locator('li[data-thread="t1"]')).toHaveCount(0);
    expect((await h.threadWrites()).map((w) => (w as { op: string }).op)).toEqual([
      'edit',
      'deleteComment',
      'deleteThread',
    ]);
  });

  test('resolving leaves the default list and a filter still reaches it; reopening brings it back (criterion 3)', async ({
    page,
  }) => {
    const { pane, view } = await openThread(page);
    await view.getByRole('button', { name: 'Resolve' }).click();
    await expect(view).toHaveAttribute('data-state', 'resolved');
    await expect(view.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await view.getByRole('button', { name: 'Back to the list' }).click();
    await expect(pane.locator('li[data-thread="t1"]')).toHaveCount(0);
    await pane.getByRole('radio', { name: 'Resolved' }).check();
    await expect(pane.locator('li[data-thread="t1"]')).toHaveCount(1);
    await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
    await pane.getByRole('button', { name: 'Reopen' }).click();
    await expect(pane.locator('[data-thread-view="t1"]')).toHaveAttribute('data-state', 'open');
    await pane.getByRole('button', { name: 'Back to the list' }).click();
    await pane.getByRole('radio', { name: 'Open', exact: true }).check();
    await expect(pane.locator('li[data-thread="t1"]')).toHaveCount(1);
  });

  test('resolving elsewhere changes the open view without a reload (criterion 3)', async ({
    page,
  }) => {
    const { h, view } = await openThread(page);
    await h.putThreads([{ ...T1, state: 'resolved' }]);
    await expect(view).toHaveAttribute('data-state', 'resolved');
  });

  test('a thread whose text was removed is marked detached and stays readable (criterion 4, the view)', async ({
    page,
  }) => {
    const { view } = await openThread(page, { ...T1, detached: true });
    await expect(view.locator('[data-detached-note]')).toHaveText(
      'The commented text was removed. The thread stays here to read.',
    );
    expect(await texts(view)).toEqual(['Is this right?', 'Yes, I checked.']);
  });

  test('without comment the reply box is disabled with the reason and nothing can be resolved (criterion 5)', async ({
    page,
  }) => {
    const { view } = await openThread(page, { ...T1, caps: ['view'] }, 'user:alan');
    await expect(view.getByRole('textbox', { name: 'Reply' })).toBeDisabled();
    await expect(view.getByRole('button', { name: 'Post reply' })).toBeDisabled();
    await expect(view.locator('[data-reply-reason]')).toHaveText(
      'You do not have permission to comment on this part of the document.',
    );
    await expect(view.getByRole('textbox', { name: 'Reply' })).toHaveAccessibleDescription(
      'You do not have permission to comment on this part of the document.',
    );
    await expect(view.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  });

  test('when the thread changed under the user, the latest is shown and the draft is kept (criterion 6)', async ({
    page,
  }) => {
    const { h, view } = await openThread(page);
    await h.staleNextThread('user:alan', 'I got there first.');
    const field = view.getByRole('textbox', { name: 'Reply' });
    await field.fill('My careful answer.');
    await view.getByRole('button', { name: 'Post reply' }).click();
    await expect(view.locator('[data-thread-message]')).toHaveText(
      'This thread changed while you were writing. The latest version is shown and your text is kept.',
    );
    expect(await texts(view)).toEqual(['Is this right?', 'Yes, I checked.', 'I got there first.']);
    await expect(field).toHaveValue('My careful answer.');
    // The second try is sent with the latest version and goes through.
    await view.getByRole('button', { name: 'Post reply' }).click();
    await expect(view.locator('[data-comment] .de-comment-text')).toHaveCount(4);
    expect((await texts(view)).at(-1)).toBe('My careful answer.');
    await expect(field).toHaveValue('');
    const writes = (await h.threadWrites()) as Array<{ op: string; etag: string }>;
    expect(writes).toHaveLength(2);
    expect(writes[1]!.etag).not.toBe(writes[0]!.etag);
  });

  test('has no axe violation in the thread view', async ({ page }) => {
    await openThread(page);
    expect(await axe(page)).toEqual([]);
  });
});
