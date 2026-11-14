/**
 * Following a link to a comment in the browser (UX-034 criteria 2, 3 and 4; lane V-UX-031-045).
 * The shell's entry `openLinkedComment` (App.svelte) is called through the harness, as a host call
 * would reach it. Criterion 1 (copying the link) and the element's host method are not built here.
 */
import type { ThreadSummary } from '../src/core-api.ts';
import { axe, expect, focused, open, test } from './helpers.ts';

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
];

async function mountWithThreads(page: Parameters<typeof open>[0]) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  await h.setThreads(THREADS);
  const pane = page.locator('.de-pane[data-pane="comments"]');
  return { h, pane };
}

test.describe('following a link to a comment (UX-034, V-UX-031-045)', () => {
  test('a resolved thread that the filter hides is shown, focused and announced with author, time and state (criteria 2 to 4)', async ({
    page,
  }) => {
    const { h, pane } = await mountWithThreads(page);
    // The default filter is open threads only, so t2 (resolved) is hidden until the link is followed.
    expect(await h.openLinkedComment('t2')).toBe('open');
    await expect(pane).toBeVisible();
    await expect(pane.locator('li[data-thread="t2"]')).toBeVisible();
    await expect(pane.getByRole('radio', { name: 'All' })).toBeChecked();
    // Focused: the thread's head is the focused control, with its name (author, state, replies).
    await expect
      .poll(async () => (await focused(page)).text)
      .toBe('Grace Hopper, Resolved, 0 replies');
    // Announced: author, time and state, in the shell's live region, and nothing of the thread text.
    const live = page.locator('.de-shell > [role="status"]');
    await expect(live).toHaveText(/^Grace Hopper, \S.*, Resolved\.$/);
    expect(await axe(page)).toEqual([]);
  });

  test('a comment that cannot be shown gives one message and reveals nothing else (criterion 3)', async ({
    page,
  }) => {
    const { h, pane } = await mountWithThreads(page);
    expect(await h.openLinkedComment('no-such-comment')).toBe('unavailable');
    await expect(pane).toBeVisible();
    await expect(
      pane.getByText(
        'This comment cannot be shown. It may have been deleted, or you may not be able to view this document.',
      ),
    ).toBeVisible();
    // No filter, no list and no thread text: the pane holds the message only.
    expect(await pane.locator('li[data-thread]').count()).toBe(0);
    expect(await pane.getByRole('radio').count()).toBe(0);
    const text = (await pane.innerText()) ?? '';
    expect(text).not.toContain('Ada Lovelace');
    expect(text).not.toContain('Grace Hopper');
    expect(text).not.toContain('Check this sentence');
    expect(await axe(page)).toEqual([]);
  });

  test('following a link to an open thread shows it in the open filter', async ({ page }) => {
    const { h, pane } = await mountWithThreads(page);
    expect(await h.openLinkedComment('t1')).toBe('open');
    await expect(pane.locator('li[data-thread="t1"]')).toBeVisible();
    await expect.poll(async () => (await focused(page)).text).toBe('Ada Lovelace, Open, 2 replies');
  });
});
