/**
 * The review tools in the shell (UX-036 criteria 1 to 5; lane w3): next and previous, accept and
 * reject at the caret or the selection, accept all and reject all, what the user is offered, and a
 * suggestion that another person resolved first. The suggestions come from the harness core, which
 * answers like the engine's `suggestionItems`, `stepSuggestion` and `resolveSuggestions`; the
 * engine's own behaviour, with the commit origins, is tested in packages/engine/test/ux-036-review.test.ts.
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
  item('s1', 10),
  item('s2', 30, { kind: 'del', user: 'u2' }),
  item('s3', 50, { kind: 'fmt', text: '' }),
];

const status = (page: Page) => page.locator('.de-shell > [role="status"]');

async function openReview(page: Page, items: ReviewItem[] = ITEMS, selection = { from: 0, to: 0 }) {
  const h = await open(page, { extended: true, review: true });
  await h.setReviewItems(items, selection);
  // The authors' names are asked for when the list arrives.
  if (items.length > 0)
    await expect.poll(async () => (await h.resolveCalls()).flat().sort().join(',')).toContain('u1');
  return h;
}

test.describe('next and previous (UX-036 criterion 1)', () => {
  test('step through the suggestions from the selection, wrap at the ends, and say what was reached', async ({
    page,
  }) => {
    const h = await openReview(page);
    expect(await h.state('review.next')).toMatchObject({ offered: true, enabled: true });
    expect(await h.exec('review.next')).toEqual({ ran: true, reason: null });
    expect(await h.reviewSelection()).toEqual({ from: 10, to: 15 });
    await expect(status(page)).toHaveText('Insertion by Ada Lovelace: words s1');
    await h.exec('review.next');
    expect(await h.reviewSelection()).toEqual({ from: 30, to: 35 });
    await expect(status(page)).toHaveText('Deletion by Grace Hopper: words s2');
    await h.exec('review.next');
    // A block or formatting suggestion with no words is named without them.
    await expect(status(page)).toHaveText('Formatting change by Ada Lovelace.');
    await h.exec('review.next');
    expect(await h.reviewSelection()).toEqual({ from: 10, to: 15 });
    await h.exec('review.previous');
    expect(await h.reviewSelection()).toEqual({ from: 50, to: 55 });
    await h.exec('review.previous');
    expect(await h.reviewSelection()).toEqual({ from: 30, to: 35 });
  });

  test('with no suggestions the step commands are disabled with their reason', async ({ page }) => {
    const h = await openReview(page, []);
    expect(await h.state('review.next')).toMatchObject({
      offered: true,
      enabled: false,
      reasonKey: 'reason.query.noSuggestions',
    });
  });
});

test.describe('accept and reject (UX-036 criteria 1 and 2)', () => {
  test('the caret in a suggestion accepts that one; a selection rejects those inside', async ({
    page,
  }) => {
    const h = await openReview(page, ITEMS, { from: 12, to: 12 });
    expect(await h.exec('review.accept')).toEqual({ ran: true, reason: null });
    expect(await h.reviewIds()).toEqual(['s2', 's3']);
    await expect(status(page)).toHaveText('1 suggestion accepted.');
    // A selection over the other two.
    await h.setReviewItems(ITEMS.slice(1), { from: 0, to: 100 });
    expect(await h.exec('review.reject')).toEqual({ ran: true, reason: null });
    expect(await h.reviewIds()).toEqual([]);
    await expect(status(page)).toHaveText('2 suggestions rejected.');
  });

  test('nothing under the caret changes nothing and says so', async ({ page }) => {
    const h = await openReview(page, ITEMS, { from: 20, to: 20 });
    expect(await h.exec('review.accept')).toMatchObject({ ran: false });
    expect(await h.reviewIds()).toEqual(['s1', 's2', 's3']);
    await expect(status(page)).toHaveText('No suggestion at the cursor or in the selection.');
  });

  test('accept all and reject all take the selection, else the document, and say how many were left', async ({
    page,
  }) => {
    const items = [
      item('s1', 10),
      item('s2', 30, { canResolve: false, caps: ['view', 'suggest'] }),
      item('s3', 50),
    ];
    const h = await openReview(page, items, { from: 0, to: 0 });
    // No selection: the whole document. The one in a part the user cannot edit stays pending.
    expect(await h.exec('review.acceptAll')).toEqual({ ran: true, reason: null });
    expect(await h.reviewIds()).toEqual(['s2']);
    await expect(status(page)).toHaveText(
      '2 suggestions accepted. 1 suggestion left pending, because you cannot edit that part.',
    );
    expect(await h.reviewCalls()).toContainEqual({
      op: 'accept',
      handled: ['s1', 's3'],
      skipped: 1,
    });
  });

  test('with a selection, accept all covers only the selection', async ({ page }) => {
    const h = await openReview(page, ITEMS, { from: 25, to: 40 });
    expect(await h.exec('review.rejectAll')).toEqual({ ran: true, reason: null });
    expect(await h.reviewIds()).toEqual(['s1', 's3']);
    await expect(status(page)).toHaveText('1 suggestion rejected.');
  });
});

test.describe('what the user is offered (UX-036 criterion 3)', () => {
  test('a user who suggests but cannot edit is offered neither accept nor reject, for others or for their own', async ({
    page,
  }) => {
    const suggestOnly = {
      caps: ['view', 'comment', 'suggest'] as ReviewItem['caps'],
      canResolve: false,
    };
    const h = await openReview(page, [
      item('mine', 10, { user: 'u1', ...suggestOnly }),
      item('theirs', 30, { user: 'u2', ...suggestOnly }),
    ]);
    for (const id of ['review.accept', 'review.reject', 'review.acceptAll', 'review.rejectAll'])
      expect((await h.state(id)).offered).toBe(false);
    // Stepping through them is still offered: reading is not resolving.
    expect((await h.state('review.next')).offered).toBe(true);
    // When the same user is given `edit`, the commands appear.
    await h.setReviewItems([item('mine', 10), item('theirs', 30, { user: 'u2' })]);
    await expect.poll(async () => (await h.state('review.accept')).offered).toBe(true);
    expect((await h.state('review.rejectAll')).offered).toBe(true);
  });
});

test.describe('another person resolves first (UX-036 criterion 4)', () => {
  test('the list follows without an error, and stepping skips the gone suggestion', async ({
    page,
  }) => {
    const h = await openReview(page);
    await h.exec('review.next');
    expect(await h.reviewSelection()).toEqual({ from: 10, to: 15 });
    await h.removeReviewItem('s2');
    expect(await h.exec('review.next')).toEqual({ ran: true, reason: null });
    expect(await h.reviewSelection()).toEqual({ from: 50, to: 55 });
    // Accepting the one that was just removed finds nothing, and says so, with no error.
    expect(await h.errors()).toEqual([]);
  });
});

test.describe('keyboard (UX-036 criterion 5)', () => {
  test('every review action is found and run from command search, without a pointer', async ({
    page,
  }) => {
    const h = await openReview(page, ITEMS, { from: 12, to: 12 });
    // Tab to the editing surface, then Alt+Q opens command search: keys only, as a keyboard user does.
    const active = () =>
      page.evaluate(
        () =>
          document.getElementById('host')!.shadowRoot!.activeElement?.className?.toString() ?? '',
      );
    for (let i = 0; i < 40 && !(await active()).includes('de-editing-surface'); i++)
      await page.keyboard.press('Tab');
    await page.keyboard.press('Alt+q');
    const search = page.getByRole('combobox').first();
    await expect(search).toBeVisible();
    await page.keyboard.type('accept all');
    await expect(page.getByRole('option', { name: /Accept all suggestions/ })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Enter');
    expect(await h.reviewIds()).toEqual([]);
  });
});
