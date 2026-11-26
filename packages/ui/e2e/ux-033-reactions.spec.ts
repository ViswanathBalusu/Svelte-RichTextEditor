/**
 * Reactions to a comment in the thread view (UX-033; 13 §5; ADR 0424), with the harness's threads
 * port: each of the six reactions is a toggle button with a name, a pressed state and a count, the
 * people behind it are named, another client's reaction appears without a reload, a reaction is
 * not a commit and sends no tag, and a backend that does not announce the feature gets no control.
 * The product's own run, with the element and the mock backend, is
 * packages/element/e2e/ux-033-reactions.spec.ts.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-033-reactions`.
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
  ],
};

async function openThread(page: Page, detail = T1, offer = true) {
  const h = await open(page, { extended: true, comments: true, commentsPane: true });
  if (offer) await h.offerReactions();
  await h.setThreads(SUMMARIES);
  await h.putThreads([detail]);
  await h.setThreadUser('user:ada');
  expect(await h.exec('view.comments')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="comments"]');
  await pane.locator('li[data-thread="t1"] [data-thread-open]').click();
  const view = pane.locator('[data-thread-view="t1"]');
  await expect(view).toBeVisible();
  return { h, view };
}

const button = (view: ReturnType<Page['locator']>, reaction: string) =>
  view.locator(`[data-comment="c1"] [data-reaction="${reaction}"]`);

test.describe('reactions to a comment (UX-033)', () => {
  test('a reaction toggles, shows its count and names, and sends no tag (criteria 1 and 3)', async ({
    page,
  }) => {
    const { h, view } = await openThread(page);
    const heart = button(view, 'heart');
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    await expect(heart).toHaveAccessibleName('Heart, 0');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    await expect(heart).toHaveAccessibleName('Heart, 1');
    await expect(view.locator('[data-reaction-people="heart"]')).toContainText('Heart:');
    // Reacting again removes it.
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    await expect(view.locator('[data-reaction-people="heart"]')).toHaveCount(0);
    const writes = (await h.threadWrites()) as Array<Record<string, unknown>>;
    expect(writes.filter((w) => w['op'] === 'react')).toEqual([
      { op: 'react', id: 't1', commentId: 'c1', reaction: 'heart', on: true },
      { op: 'react', id: 't1', commentId: 'c1', reaction: 'heart', on: false },
    ]);
    // A reaction is not a change of the thread: no tag goes with it.
    expect(writes.every((w) => !('etag' in w))).toBe(true);
  });

  test('another client reacting is shown without a reload (criterion 2)', async ({ page }) => {
    const { h, view } = await openThread(page);
    await h.remoteReact('t1', 'c1', 'celebrate', 'user:grace', true);
    await expect(button(view, 'celebrate')).toHaveAccessibleName('Celebrate, 1');
    await expect(button(view, 'celebrate')).toHaveAttribute('aria-pressed', 'false');
    await h.remoteReact('t1', 'c1', 'celebrate', 'user:ada', true);
    await expect(button(view, 'celebrate')).toHaveAccessibleName('Celebrate, 2');
    await expect(button(view, 'celebrate')).toHaveAttribute('aria-pressed', 'true');
    await h.remoteReact('t1', 'c1', 'celebrate', 'user:grace', false);
    await expect(button(view, 'celebrate')).toHaveAccessibleName('Celebrate, 1');
  });

  test('no reaction control without the feature (criterion 4)', async ({ page }) => {
    const { view } = await openThread(page, T1, false);
    await expect(view.locator('[data-comment="c1"]')).toBeVisible();
    await expect(view.locator('[data-reactions]')).toHaveCount(0);
    await expect(view.locator('[data-reaction]')).toHaveCount(0);
  });

  test('a user without comment sees the reactions and cannot change them', async ({ page }) => {
    const { view } = await openThread(page, { ...T1, caps: ['view'] });
    await expect(button(view, 'heart')).toBeDisabled();
  });

  test('has a name, a pressed state and a count, works from the keyboard, and passes axe (criterion 5)', async ({
    page,
  }) => {
    const { view } = await openThread(page);
    const group = view.locator('[data-comment="c1"] [data-reactions]');
    await expect(group).toHaveAttribute('role', 'group');
    await expect(group).toHaveAccessibleName('Reactions');
    await button(view, 'eyes').focus();
    await page.keyboard.press('Space');
    await expect(button(view, 'eyes')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter');
    await expect(button(view, 'eyes')).toHaveAttribute('aria-pressed', 'false');
    expect(await axe(page)).toEqual([]);
  });
});
