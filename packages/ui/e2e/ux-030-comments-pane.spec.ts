/**
 * The comments pane in the browser (UX-030 criteria 1, 3 and 6; lane V-UX-016-030). The threads come
 * from the harness's threads port, given out of document order, so the order the pane shows is the
 * order `paneRows` and `filterThreads` give, not the order the core listed them in.
 */
import type { Page } from '@playwright/test';
import type { ThreadSummary } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const RANGE = { range: { from: 3, to: 12, baseSeq: 41 } } as const;

const THREADS: ThreadSummary[] = [
  {
    id: 't1',
    position: 30,
    state: 'open',
    author: 'Ada Lovelace',
    createdAt: '2026-11-10T09:15:00.000Z',
    replyCount: 2,
    assignee: 'Grace Hopper',
    target: RANGE,
    excerpt: 'Check this sentence.',
    blockKind: null,
  },
  {
    id: 't2',
    position: 10,
    state: 'resolved',
    author: 'Grace Hopper',
    createdAt: '2026-11-09T14:00:00.000Z',
    replyCount: 0,
    assignee: null,
    target: { block: 'fig1' },
    excerpt: null,
    blockKind: 'figure',
  },
  {
    id: 't3',
    position: 50,
    state: 'open',
    author: 'Alan Turing',
    createdAt: '2026-11-11T16:30:00.000Z',
    replyCount: 1,
    assignee: 'Grace Hopper',
    target: RANGE,
    // The commented text was removed: the thread is detached (UX-029 criterion 4).
    excerpt: null,
    blockKind: null,
  },
];

async function openPane(page: Page, items: ThreadSummary[] = THREADS) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  await h.setThreads(items);
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await expect(pane).toBeVisible();
  return { h, pane, rows: pane.locator('li[data-thread]') };
}

function ids(locator: ReturnType<Page['locator']>): Promise<string[]> {
  return locator.evaluateAll((els) => els.map((el) => el.getAttribute('data-thread') ?? ''));
}

test.describe('the comments pane (UX-030)', () => {
  test('lists the open threads in document order with author, time, state, target and replies (criterion 1)', async ({
    page,
  }) => {
    const { pane, rows } = await openPane(page);
    // Default filter: open threads only; t2 (resolved) is left out, t1 (position 30) before t3 (50).
    expect(await ids(rows)).toEqual(['t1', 't3']);
    const first = pane.locator('li[data-thread="t1"]');
    await expect(first.locator('.de-comment-author')).toHaveText('Ada Lovelace');
    await expect(first.locator('.de-comment-state')).toHaveText('Open');
    await expect(first.locator('.de-comment-replies')).toHaveText('2 replies');
    await expect(first.locator('time')).toHaveAttribute('datetime', '2026-11-10T09:15:00.000Z');
    await expect(first.locator('time')).not.toHaveText('');
    await expect(first.locator('.de-comment-target')).toHaveText('On “Check this sentence.”.');
    // A thread whose commented text was removed says so, rather than showing nothing.
    await expect(pane.locator('li[data-thread="t3"] .de-comment-target')).toHaveText(
      'The commented text was removed.',
    );
    expect(await axe(page)).toEqual([]);
  });

  test('the resolved filter lists only resolved threads, and all lists every thread in order (criterion 3)', async ({
    page,
  }) => {
    const { pane, rows } = await openPane(page);
    await pane.getByRole('radio', { name: 'Resolved' }).check();
    expect(await ids(rows)).toEqual(['t2']);
    await expect(pane.locator('li[data-thread="t2"] .de-comment-target')).toHaveText(
      'On a figure.',
    );
    await expect(pane.locator('li[data-thread="t2"] .de-comment-replies')).toHaveText('0 replies');
    await pane.getByRole('radio', { name: 'All' }).check();
    expect(await ids(rows)).toEqual(['t2', 't1', 't3']);
  });

  test('the assignee filter narrows the list to one person, combined with the state (criterion 3)', async ({
    page,
  }) => {
    const { pane, rows } = await openPane(page);
    await pane.getByRole('radio', { name: 'All' }).check();
    await pane.getByLabel('Assigned to').selectOption('Grace Hopper');
    expect(await ids(rows)).toEqual(['t1', 't3']);
    await pane.getByRole('radio', { name: 'Resolved' }).check();
    await expect(pane.locator('.de-comments-list')).toHaveCount(0);
    await expect(pane.getByText('No comments match this view.')).toBeVisible();
    // Anyone again: the resolved thread t2 is back, and it is the only one.
    await pane.getByLabel('Assigned to').selectOption('');
    expect(await ids(rows)).toEqual(['t2']);
    await pane.getByRole('radio', { name: 'All' }).check();
    expect(await ids(rows)).toEqual(['t2', 't1', 't3']);
  });

  test('each thread is one named item, named by author, state and reply count (criterion 6)', async ({
    page,
  }) => {
    const { pane } = await openPane(page);
    const group = pane.getByRole('group', { name: 'Ada Lovelace, Open, 2 replies' });
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute('tabindex', '0');
    await expect(pane.getByRole('group', { name: 'Alan Turing, Open, 1 reply' })).toBeVisible();
    // A thread with no text name would be unreachable by name: none is left unnamed.
    expect(await pane.locator('li[data-thread] [role="group"]:not([aria-label])').count()).toBe(0);
  });

  test('a document without threads shows the empty message', async ({ page }) => {
    const { pane, rows } = await openPane(page, []);
    expect(await ids(rows)).toEqual([]);
    await expect(pane.getByText('No comments match this view.')).toBeVisible();
  });
});
