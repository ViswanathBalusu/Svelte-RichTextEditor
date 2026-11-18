/**
 * A mention as it is shown, and a mention that is refused (UX-031 criterion 3 and owner decision
 * 35; lane w3). The thread comes from the harness's threads port; the host's directory answers
 * `resolveUsers`. The stored node holds the principal only: the name on screen is the directory's.
 */
import type { ThreadDetail, ThreadSummary } from '../src/core-api.ts';
import { expect, open, test } from './helpers.ts';

const SUMMARY: ThreadSummary = {
  id: 't1',
  position: 10,
  state: 'open',
  author: 'Ada Lovelace',
  createdAt: '2026-11-10T09:15:00.000Z',
  replyCount: 0,
  assignee: null,
  target: { range: { from: 3, to: 12, baseSeq: 41 } },
  excerpt: 'Check this sentence.',
  blockKind: null,
};

const DETAIL: Omit<ThreadDetail, 'etag'> = {
  id: 't1',
  state: 'open',
  author: 'user:u1',
  detached: false,
  caps: ['view', 'comment'],
  comments: [
    {
      id: 'c1',
      author: 'user:u1',
      createdAt: '2026-11-10T09:15:00.000Z',
      body: [
        { type: 'text', text: 'Please look, ' },
        { type: 'mention', principal: 'user:u2' },
        { type: 'text', text: ', and ' },
        { type: 'mention', principal: 'user:u3' },
        { type: 'text', text: ', and ' },
        { type: 'mention', principal: 'user:nobody' },
        { type: 'text', text: ' and ' },
        { type: 'mention', principal: 'group:editors' },
        { type: 'text', text: '.' },
      ],
      edited: false,
    },
  ],
};

async function openThread(
  page: Parameters<typeof open>[0],
  people: 'host' | 'failing' | 'none' = 'host',
) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true, people });
  await h.setThreads([SUMMARY]);
  await h.putThreads([DETAIL]);
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
  const text = pane.locator('[data-comment="c1"] .de-comment-text');
  await expect(text).toBeVisible();
  return { h, text };
}

test.describe('a mention is shown with the name from resolveUsers (UX-031 criterion 3)', () => {
  test('the name is the directory name, as text; the node keeps the principal only', async ({
    page,
  }) => {
    const { h, text } = await openThread(page);
    await expect(text.locator('[data-principal="user:u2"]')).toHaveText('@Grace Hopper');
    // A name that is markup is shown as the text it is, never as an element.
    await expect(text.locator('[data-principal="user:u3"]')).toHaveText(
      '@<img src=x onerror="window.__pwned=1">',
    );
    expect(await text.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
    // A person the host does not know, and a group (which has no lookup), get the neutral label.
    await expect(text.locator('[data-principal="user:nobody"]')).toHaveText('@Collaborator');
    await expect(text.locator('[data-principal="group:editors"]')).toHaveText('@Collaborator');
    await expect(text).toHaveText(
      'Please look, @Grace Hopper, and @<img src=x onerror="window.__pwned=1">, and @Collaborator and @Collaborator.',
    );
    // The host was asked for the user identifiers once, without the `user:` prefix and without the group.
    const asked = (await h.resolveCalls()).flat();
    expect(asked.sort()).toEqual(['nobody', 'u2', 'u3']);
    // Showing the thread wrote nothing to the service.
    expect(await h.threadWrites()).toEqual([]);
  });

  test('without resolveUsers, or when it fails, the neutral label is shown and the text still reads', async ({
    page,
  }) => {
    for (const people of ['none', 'failing'] as const) {
      const { text } = await openThread(page, people);
      await expect(text.locator('[data-principal="user:u2"]')).toHaveText('@Collaborator');
      await expect(text).toContainText('Please look, @Collaborator');
    }
  });
});

test.describe('a mention of someone who cannot see the content is refused (owner decision 35)', () => {
  test('the service refuses: the message says why, the text is kept, and no access is requested', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true, accessRequests: true });
    expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
    const box = page.locator('[data-dialog="comment"]');
    const field = box.getByRole('textbox', { name: 'Comment' });
    await field.pressSequentially('Please ask @Gr');
    await field.press('Enter');
    await field.pressSequentially('to check.');
    await h.refuseNextThread('mention_hidden');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box.getByRole('alert')).toHaveText(
      'A person you mentioned cannot see the part of the document this comment is on, so it was not added. Remove the mention to post it. Your text is kept.',
    );
    await expect(field).toHaveValue('Please ask @Grace Hopper to check.');
    await expect(box).toBeVisible();
    // No request for access was made on the person's behalf.
    expect(await h.accessRequests()).toEqual([]);
    await expect(box.getByRole('button', { name: /access/i })).toHaveCount(0);
    // Without the mention the same comment is posted.
    await field.fill('Please ask someone to check.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
  });
});
