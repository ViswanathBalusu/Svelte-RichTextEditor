/**
 * The link to a comment through the product (UX-034; owner decision 88): two real `<doc-editor>`
 * elements on one document of the embed page's mock backend. The first user asks for the link to a
 * comment; the element raises `de-comment-link-request` with identifiers only; the host page builds
 * the address from its own page address and gives it back with `copyCommentLink`, which copies it.
 * The second user's element is given the marker back with `openComment`: it opens the comments
 * pane at the thread. When the thread is gone, the same call shows the message and nothing else.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-034-comment-link.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
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

type LinkElement = HTMLElement & {
  copyCommentLink(address: string): Promise<boolean>;
  openComment(marker: string): Promise<string>;
};

test('the link of a comment is built by the host, copied by the element and followed in another one (UX-034)', async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada' });
  await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
  const one = page.locator('doc-editor[data-test="one"]');
  const two = page.locator('doc-editor[data-test="two"]');

  // The host page answers the request with an address of its own (criterion 1).
  await page.evaluate(() => {
    const el = document.querySelector('doc-editor[data-test="one"]') as LinkElement;
    (window as unknown as { requests: unknown[] }).requests = [];
    el.addEventListener('de-comment-link-request', (event) => {
      const d = (event as CustomEvent).detail as { docId: string; marker: string };
      (window as unknown as { requests: unknown[] }).requests.push(d);
      void el.copyCommentLink('https://host.example/doc/' + d.docId + '?comment=' + d.marker);
    });
  });

  await selectWords(page, 'one');
  expect(await exec(page, 'one', 'review.comment')).toMatchObject({ ok: true });
  const box = one.locator('[data-dialog="comment"]');
  await box.getByRole('textbox', { name: 'Comment' }).fill('Is this the right word?');
  await box.getByRole('button', { name: 'Post' }).click();
  await expect(box).toBeHidden();
  expect(await exec(page, 'one', 'view.comments')).toMatchObject({ ok: true });
  await one.locator('[data-thread-open]').click();
  await one.locator('[data-comment-link]').first().click();

  const requests = (await page.evaluate(
    () => (window as unknown as { requests: unknown[] }).requests,
  )) as Array<{ docId: string; thread: string; comment: string; marker: string }>;
  expect(requests).toHaveLength(1);
  const { docId, marker } = requests[0]!;
  // Identifiers only: no text of the comment goes to the host.
  expect(Object.keys(requests[0]!).sort()).toEqual(['comment', 'docId', 'marker', 'thread']);
  expect(JSON.stringify(requests[0])).not.toContain('right word');
  if (browserName === 'chromium')
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('https://host.example/doc/' + docId + '?comment=' + marker);
  await expect(one.getByRole('status').filter({ hasText: 'Link copied.' })).toHaveCount(1);

  // The host passes the marker back to the other element, which shows the thread (criterion 2).
  await expect(two.locator('.de-comment-range').first()).toBeVisible();
  const followed = await page.evaluate(
    (m) => (document.querySelector('doc-editor[data-test="two"]') as LinkElement).openComment(m),
    marker,
  );
  expect(followed).toBe('open');
  await expect(two.locator('.de-pane[data-pane="comments"]')).toBeVisible();
  await expect(two.locator('[data-thread-open]').first()).toBeVisible();

  // After the thread is deleted, following the link shows the message and nothing else (criterion 3).
  await one.locator('[data-thread-delete]').click();
  await expect(two.locator('.de-comment-row')).toHaveCount(0);
  const gone = await page.evaluate(
    (m) => (document.querySelector('doc-editor[data-test="two"]') as LinkElement).openComment(m),
    marker,
  );
  expect(gone).toBe('unavailable');
  await expect(two.locator('.de-pane[data-pane="comments"]')).toContainText(
    'This comment cannot be shown.',
  );
  await expect(two.locator('.de-pane[data-pane="comments"]')).not.toContainText('right word');
});
