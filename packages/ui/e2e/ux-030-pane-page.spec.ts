/**
 * The comments pane and the page choose threads for each other, the header counts the open
 * threads, and a changed list is announced (UX-030 criteria 2, 4 (the announcement), 5 and 6; lane
 * w3). The threads come from the harness's threads port; the document side of criterion 2 (the mark
 * and the scroll) is tested in the engine's body view, packages/engine/src/view/ux-030-select-thread.universal.test.ts.
 */
import type { Page } from '@playwright/test';
import type { CommentView, ThreadDetail, ThreadSummary } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

const RANGE = { range: { from: 3, to: 12, baseSeq: 41 } } as const;

function thread(id: string, position: number, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    position,
    state: 'open',
    author: 'Ada Lovelace',
    createdAt: '2026-11-10T09:15:00.000Z',
    replyCount: 0,
    assignee: null,
    target: RANGE,
    excerpt: 'Check this sentence.',
    blockKind: null,
    ...over,
  };
}

const THREADS: ThreadSummary[] = [
  thread('t1', 30),
  thread('t2', 10, {
    state: 'resolved',
    author: 'Grace Hopper',
    target: { block: 'fig1' },
    excerpt: null,
    blockKind: 'figure',
  }),
  thread('t3', 50, { author: 'Alan Turing', replyCount: 1 }),
];

const status = (page: Page) => page.locator('.de-shell > [role="status"]');

async function openPane(page: Page, items: ThreadSummary[] = THREADS) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  await h.setThreads(items);
  await h.setFeatures(['comments']);
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await expect(pane).toBeVisible();
  return { h, pane };
}

test.describe('pane and page choose a thread for each other (UX-030 criterion 2)', () => {
  test('choosing "Show in document" asks the document to show that thread, by keyboard too', async ({
    page,
  }) => {
    const { h, pane } = await openPane(page);
    const show = pane.locator('li[data-thread="t3"] [data-thread-show]');
    await expect(show).toHaveAccessibleName('Show in document, thread by Alan Turing');
    await show.focus();
    await page.keyboard.press('Enter');
    expect(await h.revealedThreads()).toEqual(['t3']);
    await expect(pane.locator('li[data-thread="t3"]')).toHaveAttribute('aria-current', 'true');
    await expect(pane.locator('li[data-thread="t1"]')).not.toHaveAttribute('aria-current', 'true');
    await expect(status(page)).toHaveText('Shown in the document.');
    // A second choice moves the mark.
    await pane.locator('li[data-thread="t1"] [data-thread-show]').click();
    expect(await h.revealedThreads()).toEqual(['t3', 't1']);
    await expect(pane.locator('li[data-thread="t3"]')).not.toHaveAttribute('aria-current', 'true');
    expect(await axe(page)).toEqual([]);
  });

  test('a highlight chosen in the page selects its thread in the pane, even one a filter hides', async ({
    page,
  }) => {
    const { h, pane } = await openPane(page);
    // Default filter is open: the resolved thread t2 is not listed.
    await expect(pane.locator('li[data-thread="t2"]')).toHaveCount(0);
    await h.pickThread('t2');
    const row = pane.locator('li[data-thread="t2"]');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row.locator('.de-comment-head')).toBeFocused();
    await expect(status(page)).toHaveText('Thread by Grace Hopper chosen in the document.');
    // The same choice again selects it again; a different one moves the selection.
    await h.pickThread('t1');
    await expect(pane.locator('li[data-thread="t1"]')).toHaveAttribute('aria-current', 'true');
    await expect(row).not.toHaveAttribute('aria-current', 'true');
    await expect(pane.locator('li[data-thread="t1"] .de-comment-head')).toBeFocused();
  });
});

test.describe('the header count and the announcement (UX-030 criteria 4 and 5)', () => {
  test('the comments button counts the open threads, with the count in its name, and opens the pane', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true, commentsPane: true });
    await h.replaceThreads(THREADS);
    await h.setFeatures(['comments']);
    const button = page.getByRole('button', { name: 'Comments, 2 open threads' });
    await expect(button).toBeVisible();
    // Another client resolves one, then another opens one: the count follows without a reload.
    await h.replaceThreads([thread('t1', 30, { state: 'resolved' }), ...THREADS.slice(1)]);
    await expect(page.getByRole('button', { name: 'Comments, 1 open thread' })).toBeVisible();
    await h.replaceThreads([...THREADS, thread('t4', 60)]);
    await expect(page.getByRole('button', { name: 'Comments, 3 open threads' })).toBeVisible();
    // `exec` and the keyboard open the pane.
    await page.getByRole('button', { name: 'Comments, 3 open threads' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.de-pane[data-pane="comments"]')).toBeVisible();
  });

  test('a count the host gives is used as given', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      comments: true,
      commentsPane: true,
      counts: { comments: 7 },
    });
    await h.setThreads(THREADS);
    await h.setFeatures(['comments']);
    await expect(page.getByRole('button', { name: 'Comments, 7 open threads' })).toBeVisible();
  });

  test('a refreshed list is announced: a new thread, a reply, a resolve, a delete', async ({
    page,
  }) => {
    const { h, pane } = await openPane(page);
    await h.replaceThreads([...THREADS, thread('t4', 60, { author: 'Edsger Dijkstra' })]);
    await expect(pane.locator('li[data-thread="t4"]')).toBeVisible();
    await expect(status(page)).toHaveText('New comment thread by Edsger Dijkstra.');
    await h.replaceThreads([
      thread('t1', 30, { replyCount: 1 }),
      ...THREADS.slice(1),
      thread('t4', 60, { author: 'Edsger Dijkstra' }),
    ]);
    await expect(status(page)).toHaveText('New reply in the thread by Ada Lovelace.');
    await h.replaceThreads([
      thread('t1', 30, { replyCount: 1, state: 'resolved' }),
      ...THREADS.slice(1),
      thread('t4', 60, { author: 'Edsger Dijkstra' }),
    ]);
    await expect(status(page)).toHaveText('Thread by Ada Lovelace resolved.');
    await h.replaceThreads([
      thread('t1', 30, { replyCount: 1, state: 'resolved' }),
      ...THREADS.slice(1),
    ]);
    await expect(status(page)).toHaveText('Thread by Edsger Dijkstra deleted.');
  });
});

test.describe('keyboard and screen reader (UX-030 criterion 6)', () => {
  test('every thread row and every comment is a named, focusable item with author and state', async ({
    page,
  }) => {
    const { h, pane } = await openPane(page);
    const comment = (id: string, author: string, createdAt: string): CommentView => ({
      id,
      author,
      createdAt,
      body: [{ type: 'text', text: `from ${author}` }],
      edited: false,
    });
    const detail: Omit<ThreadDetail, 'etag'> = {
      id: 't3',
      state: 'open',
      author: 'user:alan',
      detached: false,
      caps: ['view', 'comment'],
      comments: [
        comment('c1', 'user:alan', '2026-11-11T16:30:00.000Z'),
        comment('c2', 'user:ada', '2026-11-11T17:00:00.000Z'),
      ],
    };
    await h.putThreads([detail]);
    // The rows are reachable in order by Tab: each head, its show button, its open button.
    const head = pane.locator('li[data-thread="t1"] .de-comment-head');
    await head.focus();
    await page.keyboard.press('Tab');
    await expect(pane.locator('li[data-thread="t1"] [data-thread-show]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(pane.locator('li[data-thread="t1"] [data-thread-open]')).toBeFocused();
    await pane.locator('li[data-thread="t3"] [data-thread-open]').focus();
    await page.keyboard.press('Enter');
    // In the thread each comment is a group named by author, time and state.
    const view = pane.locator('[data-thread-view="t3"]');
    await expect(view).toBeVisible();
    const comments = view.locator('li[data-comment] .de-comment-head');
    await expect(comments).toHaveCount(2);
    for (const el of await comments.all()) {
      await expect(el).toHaveAttribute('role', 'group');
      await expect(el).toHaveAttribute('tabindex', '0');
    }
    await expect(comments.nth(0)).toHaveAccessibleName(/^alan, .+, Open$/);
    await expect(comments.nth(1)).toHaveAccessibleName(/^ada, .+, Open$/);
    await comments.nth(0).focus();
    await expect(comments.nth(0)).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });
});
