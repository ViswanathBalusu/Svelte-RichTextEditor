/**
 * FE-103 criterion 1 (lane w1): a scripted set of tasks done with the keyboard alone, in a real
 * browser, on the shell harness (the real editing core and the shell; the comment port is the
 * harness's stand-in). The tasks are: reach the editing surface, type, format, comment, change the
 * mode. Every task is started through the keyboard: Tab, typing, Ctrl+B, and the command search
 * (Alt+Q) for the comment and the mode. No pointer event of any kind (`pointerdown`, `mousedown`,
 * `pointerup`, `mouseup`) is seen by the page, which the test records and asserts.
 *
 * Run from the repository root with
 * `DOCEDIT_UI_PORT=57174 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/fe-103-scripted-tasks.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const activeClass = (page: Page): Promise<string> =>
  page.evaluate(
    () => document.getElementById('host')!.shadowRoot!.activeElement?.className?.toString() ?? '',
  );

/** Runs a command through the command search: Alt+Q, the query, Enter. */
async function runByName(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Alt+q');
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');
}

test('FE-103: reach the surface, type, format, comment and change the mode without a pointer', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __pointer: string[] };
    w.__pointer = [];
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup'])
      document.addEventListener(type, () => w.__pointer.push(type), true);
  });
  const h = await open(page, {
    extended: true,
    comments: true,
    modes: ['edit', 'review', 'view'],
    mode: 'edit',
  });

  // Task 1, reach the editing surface: Tab from the start of the page.
  for (let i = 0; i < 40 && !(await activeClass(page)).includes('de-editing-surface'); i++)
    await page.keyboard.press('Tab');
  expect(await activeClass(page)).toContain('de-editing-surface');

  // Task 2, type.
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Scripted');
  await expect(page.locator('.de-editing-surface')).toContainText('Scripted');

  // Task 3, format: select the typed word and make it bold.
  for (let i = 0; i < 'Scripted'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  expect((await h.state('format.bold')).active).toBe(false);
  await page.keyboard.press('Control+b');
  await expect.poll(async () => (await h.state('format.bold')).active).toBe(true);

  // Task 4, comment: the command search, the box, the text, Post.
  await runByName(page, 'New comment');
  const box = page.locator('[data-dialog="comment"]');
  await expect(box).toBeVisible();
  await page.keyboard.type('Checked by keyboard.');
  const post = box.getByRole('button', { name: 'Post' });
  for (
    let i = 0;
    i < 8 &&
    !(await post.evaluate(
      (el) => el === (el.getRootNode() as Document | ShadowRoot).activeElement,
    ));
    i++
  )
    await page.keyboard.press('Tab');
  await expect(post).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(box).toBeHidden();
  expect(await h.threadRequests()).toHaveLength(1);

  // Task 5, change the mode.
  expect((await h.state('mode.edit')).active).toBe(true);
  await runByName(page, 'Reviewing');
  await expect.poll(async () => (await h.state('mode.review')).active).toBe(true);

  // No pointer was used for any of it.
  expect(
    await page.evaluate(() => (window as unknown as { __pointer: string[] }).__pointer),
  ).toEqual([]);
});
