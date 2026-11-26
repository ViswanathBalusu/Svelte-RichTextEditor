/**
 * The link to a comment in the thread view (UX-034 criterion 1; owner decision 88): the shell asks
 * the element for the address of a comment, the element hands the host the identifiers and the host
 * builds the address, and the shell says whether the address was copied. The harness's threads port
 * records the request. The followed link (criterion 2 and 3) is packages/ui/e2e/ux-034-linked-comment.spec.ts
 * for the shell and packages/element/e2e/ux-034-comment-link.spec.ts for the product.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-034-comment-link`.
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

async function openThread(page: Page, offer = true) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  if (offer) await h.offerLinks();
  await h.setThreads(SUMMARIES);
  await h.putThreads([T1]);
  await h.setThreadUser('user:ada');
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
  const view = pane.locator('[data-thread-view="t1"]');
  await expect(view).toBeVisible();
  return { h, view };
}

test.describe('the link to a comment (UX-034 criterion 1)', () => {
  test('a button on each comment asks for its link, with the thread and the comment', async ({
    page,
  }) => {
    const { h, view } = await openThread(page);
    const buttons = view.locator('[data-comment-link]');
    await expect(buttons).toHaveCount(2);
    await buttons.nth(1).click();
    const writes = (await h.threadWrites()) as Array<Record<string, unknown>>;
    expect(writes.filter((w) => w['op'] === 'requestLink')).toEqual([
      { op: 'requestLink', id: 't1', commentId: 'c2' },
    ]);
  });

  test('says when the address was copied, and when it was not', async ({ page }) => {
    const { h, view } = await openThread(page);
    await view.locator('[data-comment="c1"] [data-comment-link]').click();
    await h.answerLink(true);
    await expect(page.getByRole('status').filter({ hasText: 'Link copied.' })).toHaveCount(1);
    await view.locator('[data-comment="c1"] [data-comment-link]').click();
    await h.answerLink(false);
    await expect(view.getByText('The link could not be copied.')).toBeVisible();
  });

  test('is not offered when the element can ask nobody', async ({ page }) => {
    const { view } = await openThread(page, false);
    await expect(view.locator('[data-comment="c1"]')).toBeVisible();
    await expect(view.locator('[data-comment-link]')).toHaveCount(0);
  });

  test('is a button with a name that a keyboard reaches, and passes axe', async ({ page }) => {
    const { view } = await openThread(page);
    const button = view.locator('[data-comment="c1"] [data-comment-link]');
    await expect(button).toHaveAccessibleName('Copy link');
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await axe(page)).toEqual([]);
  });

  test('the marker the host passes back may name any comment of the thread (decision 88)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true, commentsPane: true });
    await h.setThreads(SUMMARIES);
    await h.putThreads([T1]);
    expect(await h.openLinkedComment('c2')).toBe('open');
    await expect(page.locator('.de-pane[data-pane="comments"]')).toBeVisible();
    expect(await h.openLinkedComment('no-such-comment')).toBe('unavailable');
  });
});
