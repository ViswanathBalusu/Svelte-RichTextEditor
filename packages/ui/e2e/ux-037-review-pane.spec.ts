/**
 * The review pane in the shell (UX-037 criteria 2 to 5; lane w3). The suggestions come from the
 * harness core, which answers like the engine's `suggestionItems`, `revealSuggestion` and
 * `resolveSuggestions`; the engine's own behaviour is tested in packages/engine/test/ux-036-review.test.ts
 * and the element in packages/element/e2e/ux-037-review-pane.spec.ts.
 */
import type { Page } from '@playwright/test';
import type { ReviewItem } from '../src/core-api.ts';
import { axe, expect, open, test } from './helpers.ts';

function item(id: string, from: number, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: 'ins',
    block: false,
    user: 'u1',
    from,
    to: from + 5,
    text: `words ${id}`,
    caps: ['view', 'comment', 'suggest', 'edit'],
    canResolve: true,
    ...over,
  };
}

const ITEMS: ReviewItem[] = [
  item('s3', 50, { kind: 'fmt', text: '' }),
  item('s1', 10),
  item('s4', 70, { block: true, kind: 'del', user: 'assistant:writer', text: 'A whole paragraph' }),
  item('s2', 30, { kind: 'del', user: 'u2' }),
];

const status = (page: Page) => page.locator('.de-shell > [role="status"]');

async function openPane(page: Page, items: ReviewItem[] = ITEMS) {
  const h = await open(page, { extended: true, review: true });
  await h.setReviewItems(items);
  expect(await h.exec('view.review')).toEqual({ ran: true, reason: null });
  const pane = page.locator('.de-pane[data-pane="review"]');
  await expect(pane).toBeVisible();
  const rows = pane.locator('li[data-suggestion]');
  return { h, pane, rows };
}

const ids = (rows: ReturnType<Page['locator']>): Promise<string[]> =>
  rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-suggestion') ?? ''));

test.describe('the list (UX-037 criterion 1, the parts the core can give)', () => {
  test('lists the suggestions in document order with kind, author and words', async ({ page }) => {
    const { pane, rows } = await openPane(page);
    expect(await ids(rows)).toEqual(['s1', 's2', 's3', 's4']);
    const first = pane.locator('li[data-suggestion="s1"]');
    await expect(first.locator('.de-review-kind')).toHaveText('Insertion');
    await expect(first.locator('.de-review-author')).toHaveText('Ada Lovelace');
    await expect(first.locator('.de-review-excerpt')).toHaveText('words s1');
    await expect(pane.locator('li[data-suggestion="s2"] .de-review-kind')).toHaveText('Deletion');
    await expect(pane.locator('li[data-suggestion="s2"] .de-review-author')).toHaveText(
      'Grace Hopper',
    );
    // A formatting change with no words, and a block change, are named as such.
    await expect(pane.locator('li[data-suggestion="s3"] .de-review-kind')).toHaveText(
      'Formatting change',
    );
    await expect(pane.locator('li[data-suggestion="s3"] .de-review-excerpt')).toHaveText('no text');
    await expect(pane.locator('li[data-suggestion="s4"] .de-review-kind')).toHaveText(
      'Block change',
    );
    // The core gave no commit time for these, so none is shown.
    await expect(pane.locator('time')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test('a commit time the core gives is shown as a time', async ({ page }) => {
    const { pane } = await openPane(page, [
      item('s1', 10, { committedAt: '2026-11-10T09:15:00.000Z' }),
    ]);
    await expect(pane.locator('li[data-suggestion="s1"] time')).toHaveAttribute(
      'datetime',
      '2026-11-10T09:15:00.000Z',
    );
  });

  test('without suggestions the pane says so', async ({ page }) => {
    const { pane } = await openPane(page, []);
    await expect(pane.getByText('There are no suggestions to show.')).toBeVisible();
  });
});

test.describe('the author filter (UX-037 criterion 2)', () => {
  test('lists only the chosen author, assistants included, and the bulk buttons follow the filter', async ({
    page,
  }) => {
    const { h, pane, rows } = await openPane(page);
    const select = pane.getByLabel('Author');
    await expect(select.locator('option')).toHaveCount(4);
    await select.selectOption({ label: 'Grace Hopper' });
    expect(await ids(rows)).toEqual(['s2']);
    // An assistant author is an author like any other.
    await select.selectOption({ value: 'assistant:writer' });
    expect(await ids(rows)).toEqual(['s4']);
    await select.selectOption('');
    expect(await ids(rows)).toEqual(['s1', 's2', 's3', 's4']);
    // Accept all by one author takes that author's suggestions only.
    await select.selectOption({ label: 'Grace Hopper' });
    await pane.getByRole('button', { name: 'Accept all by Grace Hopper' }).click();
    expect(await h.reviewIds()).toEqual(['s3', 's1', 's4']);
    await expect(status(page)).toHaveText('1 suggestion accepted.');
    // That author has none left: the filter is dropped, and the others are listed.
    await expect(select).toHaveValue('');
    expect(await ids(rows)).toEqual(['s1', 's3', 's4']);
    expect(await h.reviewCalls()).toContainEqual({ op: 'accept', handled: ['s2'], skipped: 0 });
  });
});

test.describe('choosing a suggestion, accept and reject (UX-037 criterion 3)', () => {
  test('Show moves the document to the suggestion; Accept and Reject resolve that one', async ({
    page,
  }) => {
    const { h, pane, rows } = await openPane(page);
    await pane.locator('li[data-suggestion="s2"] [data-review-show]').click();
    expect(await h.reviewSelection()).toEqual({ from: 30, to: 35 });
    await expect(pane.locator('li[data-suggestion="s2"]')).toHaveAttribute('aria-current', 'true');
    await pane.locator('li[data-suggestion="s2"] [data-review-accept]').click();
    expect(await h.reviewIds()).toEqual(['s3', 's1', 's4']);
    await expect(status(page)).toHaveText('1 suggestion accepted.');
    await expect.poll(() => ids(rows)).toEqual(['s1', 's3', 's4']);
    await pane
      .getByRole('button', { name: 'Reject the suggestion by Ada Lovelace' })
      .first()
      .click();
    expect(await h.reviewCalls()).toContainEqual({ op: 'reject', handled: ['s1'], skipped: 0 });
    // The list follows the core's answer in the next render, so read it until it settles.
    await expect.poll(() => ids(rows)).toEqual(['s3', 's4']);
    await expect(status(page)).toHaveText('1 suggestion rejected.');
  });

  test('a user without edit is offered Show but neither Accept nor Reject', async ({ page }) => {
    const suggestOnly = {
      caps: ['view', 'comment', 'suggest'] as ReviewItem['caps'],
      canResolve: false,
    };
    const { pane } = await openPane(page, [
      item('mine', 10, suggestOnly),
      item('theirs', 30, { user: 'u2', ...suggestOnly }),
    ]);
    await expect(pane.locator('[data-review-show]')).toHaveCount(2);
    await expect(pane.locator('[data-review-accept]')).toHaveCount(0);
    await expect(pane.locator('[data-review-reject]')).toHaveCount(0);
    await expect(pane.locator('[data-review-accept-all]')).toHaveCount(0);
  });

  test('a suggestion that another person resolved leaves the list and causes no error', async ({
    page,
  }) => {
    const { h, pane, rows } = await openPane(page);
    await h.removeReviewItem('s1');
    await expect(pane.locator('li[data-suggestion="s1"]')).toHaveCount(0);
    expect(await ids(rows)).toEqual(['s2', 's3', 's4']);
    expect(await h.errors()).toEqual([]);
  });
});

test.describe('live update (UX-037 criterion 4)', () => {
  test('a suggestion that arrives, and one that is resolved, appear and leave without a reload', async ({
    page,
  }) => {
    const { h, pane, rows } = await openPane(page, [item('s1', 10)]);
    expect(await ids(rows)).toEqual(['s1']);
    await h.setReviewItems([item('s1', 10), item('s5', 5, { user: 'u2', text: 'new words' })]);
    await expect(pane.locator('li[data-suggestion="s5"]')).toBeVisible();
    expect(await ids(rows)).toEqual(['s5', 's1']);
    await h.removeReviewItem('s1');
    await expect(pane.locator('li[data-suggestion="s1"]')).toHaveCount(0);
    expect(await ids(rows)).toEqual(['s5']);
  });
});

test.describe('keyboard and screen reader (UX-037 criterion 5)', () => {
  test('each item is a focusable group named by kind, author and words, and its buttons follow by Tab', async ({
    page,
  }) => {
    const { h, pane } = await openPane(page);
    const head = pane.locator('li[data-suggestion="s1"] .de-review-head');
    await expect(head).toHaveAttribute('role', 'group');
    await expect(head).toHaveAttribute('tabindex', '0');
    await expect(head).toHaveAccessibleName('Insertion by Ada Lovelace: words s1');
    await expect(pane.locator('li[data-suggestion="s3"] .de-review-head')).toHaveAccessibleName(
      'Formatting change by Ada Lovelace: no text',
    );
    await head.focus();
    await page.keyboard.press('Tab');
    await expect(pane.locator('li[data-suggestion="s1"] [data-review-show]')).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await h.reviewSelection()).toEqual({ from: 10, to: 15 });
    await page.keyboard.press('Tab');
    await expect(pane.locator('li[data-suggestion="s1"] [data-review-accept]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(pane.locator('li[data-suggestion="s1"] [data-review-reject]')).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await h.reviewCalls()).toContainEqual({ op: 'reject', handled: ['s1'], skipped: 0 });
    expect(await axe(page)).toEqual([]);
  });
});
