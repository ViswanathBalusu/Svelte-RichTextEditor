/**
 * The comment command and the comment box in the browser (UX-028; UX-031). Each test runs the
 * command `review.comment` through the registry (the path of the toolbar, the context menu and
 * `exec`), types in the box the command opens, and reads what the core's `threads` port received.
 */
import type { Page } from '@playwright/test';
import { axe, expect, open, test } from './helpers.ts';

const BLOCK = { selection: { kind: 'block', id: 'fig1' }, scopes: [['view', 'comment']] } as const;

async function openBox(page: Page, h: Awaited<ReturnType<typeof open>>) {
  expect(await h.exec('review.comment')).toEqual({ ran: true, reason: null });
  const box = page.locator('[data-dialog="comment"]');
  await expect(box).toBeVisible();
  return { box, field: box.getByRole('textbox', { name: 'Comment' }) };
}

test.describe('starting a comment thread (UX-028)', () => {
  test('a block selected as a block: the thread targets { block: id } and nothing is committed (criterion 2)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.setThreadAnchor(BLOCK);
    await h.frames(2);
    expect(await h.state('review.comment')).toMatchObject({ offered: true, enabled: true });
    const { box, field } = await openBox(page, h);
    await field.fill('Is this the latest figure?');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    expect(await h.threadRequests()).toEqual([
      { target: { block: 'fig1' }, body: [{ type: 'text', text: 'Is this the latest figure?' }] },
    ]);
    const request = (await h.threadRequests())[0] as { target: Record<string, unknown> };
    expect(Object.keys(request.target)).toEqual(['block']);
    // Commenting is a control-plane request: no command of the core ran.
    expect(await h.runs()).toEqual([]);
    expect(await h.named()).toEqual([]);
    await expect(page.locator('.de-shell [role="status"]').last()).toHaveText('Comment added.');
  });

  test('a text range: the thread targets { range: { from, to, baseSeq } }', async ({ page }) => {
    const h = await open(page, { extended: true, comments: true });
    const { box, field } = await openBox(page, h);
    await field.fill('Check this sentence.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    expect(await h.threadRequests()).toEqual([
      {
        target: { range: { from: 3, to: 12, baseSeq: 41 } },
        body: [{ type: 'text', text: 'Check this sentence.' }],
      },
    ]);
  });

  test('without comment in a covered scope the command is disabled with its reason', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.setThreadAnchor({ ...BLOCK, scopes: [['view', 'comment'], ['view']] });
    await h.frames(2);
    expect(await h.state('review.comment')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.noComment',
    });
    expect(await h.exec('review.comment')).toMatchObject({ ran: false });
    await expect(page.locator('[data-dialog="comment"]')).toHaveCount(0);
  });

  test('a refusal by the service keeps the typed text and shows the reason', async ({ page }) => {
    const h = await open(page, { extended: true, comments: true });
    await h.refuseNextThread('permission_denied');
    const { box, field } = await openBox(page, h);
    await field.fill('Please keep this.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box.getByRole('alert')).toHaveText(
      'Your permissions changed, so the comment was not added. Your text is kept.',
    );
    await expect(field).toHaveValue('Please keep this.');
  });
});

test.describe('mentioning people in a comment (UX-031)', () => {
  test('@ and a fragment call searchPrincipals, list the results, and choosing inserts a mention node (criterion 1)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true });
    const { box, field } = await openBox(page, h);
    await field.pressSequentially('Please ask @Gr');
    const options = box.getByRole('option');
    await expect(options).toHaveText([/Grace Hopper/]);
    expect(await h.principalQueries()).toContainEqual({
      text: 'Gr',
      purpose: 'mention',
      docId: 'd1',
    });
    await expect(field).toHaveAttribute('aria-activedescendant', /.+/);
    expect(await axe(page)).toEqual([]);
    await field.press('Enter');
    await expect(field).toHaveValue('Please ask @Grace Hopper ');
    await expect(box.getByRole('listbox')).toBeHidden();
    await field.pressSequentially('to check.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    expect(await h.threadRequests()).toEqual([
      {
        target: { range: { from: 3, to: 12, baseSeq: 41 } },
        body: [
          { type: 'text', text: 'Please ask ' },
          { type: 'mention', principal: 'user:u2' },
          { type: 'text', text: ' to check.' },
        ],
      },
    ]);
  });

  test('a late answer to an older query is ignored (criterion 2)', async ({ page }) => {
    // The answer for "L" (Ada Lovelace, Legal team) is held back until after the one for "Le".
    const h = await open(page, { extended: true, comments: true, principalDelays: { L: 600 } });
    const { box, field } = await openBox(page, h);
    await field.pressSequentially('@Le');
    const options = box.getByRole('option');
    await expect(options).toHaveText([/Legal team/]);
    // Past the time the older answer arrives: the list still shows the newer query's results.
    await page.waitForTimeout(900);
    await expect(options).toHaveText([/Legal team/]);
    const texts = (await h.principalQueries()).map((q) => q.text);
    expect(texts).toEqual(['L', 'Le']);
    await field.press('Enter');
    await expect(field).toHaveValue('@Legal team ');
  });

  test('without searchPrincipals no mention is offered and a plain comment still works (criterion 6)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, comments: true, principals: 'none' });
    const { box, field } = await openBox(page, h);
    await field.pressSequentially('Ask @Gr about it');
    await expect(box.getByRole('listbox')).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-autocomplete', /.*/);
    expect(await h.principalQueries()).toEqual([]);
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    expect(await h.threadRequests()).toEqual([
      {
        target: { range: { from: 3, to: 12, baseSeq: 41 } },
        body: [{ type: 'text', text: 'Ask @Gr about it' }],
      },
    ]);
  });
});
