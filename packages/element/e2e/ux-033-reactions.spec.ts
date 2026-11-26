/**
 * Reactions to a comment through the product (UX-033; ADR 0424): two real `<doc-editor>` elements
 * on one document of the embed page's mock backend, which announces the feature `reactions`. One
 * user reacts to a comment in the thread view; the other user's open thread shows it without a
 * reload, with the count and the pressed state of each user, and the document is not committed to.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-033-reactions.spec.ts`.
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

const seq = (page: Page, name: string): Promise<number> =>
  page.evaluate(
    (n) =>
      (
        document.querySelector('doc-editor[data-test="' + n + '"]') as unknown as {
          getContent(): Promise<{ seq: number }>;
        }
      )
        .getContent()
        .then((c) => c.seq),
    name,
  );

const heart = (editor: Locator): Locator =>
  editor.locator('[data-thread-view] [data-reaction="heart"]');

test('a reaction in one element reaches the other without a reload, with no commit (UX-033 criteria 1 to 3)', async ({
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
  await box.getByRole('textbox', { name: 'Comment' }).fill('Is this the right word?');
  await box.getByRole('button', { name: 'Post' }).click();
  await expect(box).toBeHidden();

  for (const [name, editor] of [
    ['one', one],
    ['two', two],
  ] as const) {
    expect(await exec(page, name, 'view.comments')).toMatchObject({ ok: true });
    await expect(editor.locator('.de-comment-row')).toHaveCount(1);
    await editor.locator('[data-thread-open]').click();
    await expect(editor.locator('[data-thread-view]')).toBeVisible();
  }
  const before = await seq(page, 'one');

  // Bob reacts; Ada's open thread shows it, not pressed for her.
  await heart(two).click();
  await expect(heart(two)).toHaveAttribute('aria-pressed', 'true');
  await expect(heart(one)).toHaveAccessibleName('Heart, 1');
  await expect(heart(one)).toHaveAttribute('aria-pressed', 'false');
  await expect(one.locator('[data-reaction-people="heart"]')).toBeVisible();

  // Ada reacts too: two people, pressed for both; Bob then leaves, and Ada's count falls to one.
  await heart(one).click();
  await expect(heart(one)).toHaveAccessibleName('Heart, 2');
  await expect(heart(two)).toHaveAccessibleName('Heart, 2');
  await heart(two).click();
  await expect(heart(one)).toHaveAccessibleName('Heart, 1');
  await expect(heart(one)).toHaveAttribute('aria-pressed', 'true');

  // None of it was committed (criterion 3).
  expect(await seq(page, 'two')).toBe(before);
});
