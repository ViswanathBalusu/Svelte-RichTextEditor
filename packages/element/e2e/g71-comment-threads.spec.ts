/**
 * Comment threads through the product (gap G71; ADR 0417; UX-028, UX-029, UX-030, UX-032, FE-048):
 * two real `<doc-editor>` elements on one document of the embed page's mock backend. The first user
 * selects words, comments, replies, resolves and assigns through the shell; the second user's
 * element, which holds no reply and was never reloaded, shows each change. Run from the repository
 * root with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/g71-comment-threads.spec.ts`.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const WORDS = 'Alpha';

/** Selects the first five characters of the first paragraph of an editor, as a reader would. */
async function selectWords(page: Page, name: string): Promise<void> {
  const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
  await surface.locator('p').first().click();
  await page.keyboard.press('Home');
  for (let i = 0; i < WORDS.length; i++) await page.keyboard.press('Shift+ArrowRight');
  // The editor reads the selection on the frame after the keys: let two frames pass.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/** The text under the comment marks of an element (a mark may split at formatting). */
async function markedText(editor: Locator): Promise<string> {
  return (await editor.locator('.de-comment-range').allInnerTexts()).join('');
}

function exec(page: Page, name: string, command: string): Promise<unknown> {
  return page.evaluate(
    ([n, c]) =>
      (
        document.querySelector(`doc-editor[data-test="${n}"]`) as unknown as {
          exec(command: string): unknown;
        }
      ).exec(c!),
    [name, command],
  );
}

test.describe('comment threads in two elements', () => {
  test('a comment made in one element reaches the other without a reload, with no commit', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const one = page.locator('doc-editor[data-test="one"]');
    const two = page.locator('doc-editor[data-test="two"]');
    const seqBefore = await page.evaluate(() =>
      (
        document.querySelector('doc-editor[data-test="one"]') as unknown as {
          getContent(): Promise<{ seq: number }>;
        }
      )
        .getContent()
        .then((c) => c.seq),
    );

    // The first user comments on the selected words (UX-028 criterion 1).
    await selectWords(page, 'one');
    expect(await exec(page, 'one', 'review.comment')).toMatchObject({ ok: true });
    const box = one.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    await box.getByRole('textbox', { name: 'Comment' }).fill('Is this the right word?');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();

    // The words are marked in the first element, and in the second one when the notice arrives
    // (UX-028 criterion 7; FE-048 criterion 4).
    await expect.poll(() => markedText(one)).toBe(WORDS);
    await expect.poll(() => markedText(two)).toBe(WORDS);

    // The second user's comments pane lists the thread, and the count says one open thread.
    expect(await exec(page, 'two', 'view.comments')).toMatchObject({ ok: true });
    const row = two.locator('.de-comment-row').first();
    await expect(row).toBeVisible();
    await expect(row.locator('[data-content]')).toContainText(WORDS);
    await expect(row.getByRole('group').first()).toHaveAttribute('aria-label', /Open, 0 replies/);

    // Nothing was committed by the thread: the document is the one that was loaded (FE-048 criterion 6).
    const seqAfter = await page.evaluate(() =>
      (
        document.querySelector('doc-editor[data-test="two"]') as unknown as {
          getContent(): Promise<{ seq: number }>;
        }
      )
        .getContent()
        .then((c) => c.seq),
    );
    expect(seqAfter).toBe(seqBefore);
  });

  test('a reply, a resolve and a reopen are shown live in the other element (UX-029 criteria 1 and 3)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const one = page.locator('doc-editor[data-test="one"]');
    const two = page.locator('doc-editor[data-test="two"]');

    await selectWords(page, 'one');
    expect(await exec(page, 'one', 'review.comment')).toMatchObject({ ok: true });
    const box = one.locator('[data-dialog="comment"]');
    await box.getByRole('textbox', { name: 'Comment' }).fill('First comment.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();

    // Both users open the thread from the comments pane.
    for (const [name, editor] of [
      ['one', one],
      ['two', two],
    ] as const) {
      expect(await exec(page, name, 'view.comments')).toMatchObject({ ok: true });
      await expect(editor.locator('.de-comment-row')).toHaveCount(1);
      await editor.locator('[data-thread-open]').click();
      await expect(editor.locator('[data-thread-view]')).toBeVisible();
    }

    // Bob replies; Ada's open thread shows the reply without a reload.
    await two.locator('[data-reply-field]').fill('A reply from the other user.');
    await two.locator('[data-reply-post]').click();
    await expect(one.locator('[data-thread-view] li')).toHaveCount(2);
    await expect(one.locator('[data-thread-view]')).toContainText('A reply from the other user.');

    // Ada resolves; Bob's view shows it, and Bob reopens; Ada's view shows that.
    await one.locator('[data-thread-state]').click();
    await expect(one.locator('[data-thread-view]')).toHaveAttribute('data-state', 'resolved');
    await expect(two.locator('[data-thread-view]')).toHaveAttribute('data-state', 'resolved');
    await two.locator('[data-thread-state]').click();
    await expect(two.locator('[data-thread-view]')).toHaveAttribute('data-state', 'open');
    await expect(one.locator('[data-thread-view]')).toHaveAttribute('data-state', 'open');
  });

  test('an assignment and its clearing are shown live in the other element (UX-032 criterion 2)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const one = page.locator('doc-editor[data-test="one"]');
    const two = page.locator('doc-editor[data-test="two"]');
    // The host's directory search, as a host sets it after the element loaded.
    await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="one"]') as unknown as {
        searchPrincipals: unknown;
      };
      el.searchPrincipals = async (q: { text: string }) =>
        'bob'.startsWith(q.text.toLowerCase())
          ? [{ principal: 'user:bob', name: 'Bob Example' }]
          : [];
    });

    await selectWords(page, 'one');
    expect(await exec(page, 'one', 'review.comment')).toMatchObject({ ok: true });
    const box = one.locator('[data-dialog="comment"]');
    await box.getByRole('textbox', { name: 'Comment' }).fill('Please check.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    for (const [name, editor] of [
      ['one', one],
      ['two', two],
    ] as const) {
      expect(await exec(page, name, 'view.comments')).toMatchObject({ ok: true });
      await expect(editor.locator('.de-comment-row')).toHaveCount(1);
    }
    await one.locator('[data-thread-open]').click();
    const field = one.locator('[data-assign-field]');
    await field.fill('bo');
    await expect(one.getByRole('option')).toHaveCount(1);
    await field.press('Enter');
    await expect(one.locator('[data-thread-view] [data-assignee]')).toBeVisible();
    // Bob's pane row shows the task without a reload.
    await expect(two.locator('.de-comment-row [data-assignee]')).toBeVisible();
    // Clearing it is shown to him as well.
    await one.locator('[data-assign-clear]').click();
    await expect(two.locator('.de-comment-row [data-assignee]')).toHaveCount(0);
  });

  test('the pane of the other element refreshes from the notices and announces each change (UX-030 criterion 4)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const one = page.locator('doc-editor[data-test="one"]');
    const two = page.locator('doc-editor[data-test="two"]');
    // Bob has the pane open before anything happens.
    expect(await exec(page, 'two', 'view.comments')).toMatchObject({ ok: true });
    await expect(two.locator('.de-comment-row')).toHaveCount(0);
    const announced = two.locator('.de-shell > [role="status"]');

    await selectWords(page, 'one');
    expect(await exec(page, 'one', 'review.comment')).toMatchObject({ ok: true });
    const box = one.locator('[data-dialog="comment"]');
    await box.getByRole('textbox', { name: 'Comment' }).fill('Please look.');
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();
    await expect(two.locator('.de-comment-row')).toHaveCount(1);
    await expect(announced).toHaveText(/^New comment thread by /);

    // Ada opens the thread, replies, resolves and deletes it; Bob's pane follows and says so.
    expect(await exec(page, 'one', 'view.comments')).toMatchObject({ ok: true });
    await one.locator('[data-thread-open]').click();
    await one.locator('[data-reply-field]').fill('And another thing.');
    await one.locator('[data-reply-post]').click();
    await expect(two.locator('.de-comment-replies')).toHaveText(/1 repl/);
    await expect(announced).toHaveText(/^New reply in the thread by /);
    await one.locator('[data-thread-state]').click();
    await expect(announced).toHaveText(/ resolved.$/);
    await one.locator('[data-thread-delete]').click();
    await expect(two.locator('.de-comment-row')).toHaveCount(0);
    await expect(announced).toHaveText(/ deleted.$/);
  });
});
