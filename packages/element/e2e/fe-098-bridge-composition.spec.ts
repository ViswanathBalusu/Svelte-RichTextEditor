/**
 * FE-098 (the input bridge of the page view), what a headless browser can show of criteria 2 and 3:
 * an input method composition is a series of edits in the document; the bridge stays on the painted
 * caret; a remote commit to the block being composed waits until the composition ends (spike S1,
 * FE-034). The composition is made with the Chrome DevTools protocol (`Input.imeSetComposition`), so
 * this is Chromium only and is a stand-in for a real input method: it does not tick criterion 2 (the
 * S1 matrix of Japanese, Chinese and Korean input methods, dead keys and phone keyboards) or 3 (the
 * window of a real input method at the caret). Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57098 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-098-bridge-composition.spec.ts --project=chromium`.
 */
import { expect, test, type Page } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

test.beforeEach(({ browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'composition is driven through the Chrome DevTools protocol',
  );
});

async function openPageView(page: Page) {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
  const h = await openS1(page);
  await page.evaluate(() => document.querySelector('doc-editor')!.setAttribute('view', 'print'));
  await expect(page.locator('doc-editor .de-page-view .de-line').first()).toBeVisible();
  return h;
}

test('a composition is edits in the document, and the result is committed once (criterion 2, stand-in)', async ({
  page,
}) => {
  const h = await openPageView(page);
  await page.locator('doc-editor .de-page-view .de-line').first().click();
  const before = await h.bodyText();
  const client = await page.context().newCDPSession(page);
  await client.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect.poll(async () => (await h.bodyText()).includes('に')).toBe(true);
  await client.send('Input.imeSetComposition', {
    text: '日本',
    selectionStart: 2,
    selectionEnd: 2,
  });
  await expect.poll(async () => (await h.bodyText()).includes('日本')).toBe(true);
  // The first composing text was replaced, not kept beside the second.
  expect(await h.bodyText()).not.toContain('に日本');
  await client.send('Input.insertText', { text: '日本' });
  await expect.poll(async () => (await h.bodyText()).includes('日本')).toBe(true);
  expect((await h.bodyText()).replace('日本', '')).toBe(before);
  // The pages show the result.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [
          ...document
            .querySelector('doc-editor')!
            .shadowRoot!.querySelectorAll('.de-page-view .de-line'),
        ]
          .map((l) => l.textContent)
          .join('')
          .includes('日本'),
      ),
    )
    .toBe(true);
});

test('a remote commit to the block being composed waits until the composition ends (criterion 2, stand-in)', async ({
  page,
}) => {
  const h = await openPageView(page);
  // The first line is the heading "Scope" (SPIKE_IDS.title).
  await page.locator('doc-editor .de-page-view .de-line').first().click();
  const client = await page.context().newCDPSession(page);
  await client.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await expect.poll(async () => (await h.bodyText()).includes('に')).toBe(true);

  const answer = await h.remote({
    kind: 'insert',
    node: SPIKE_IDS.title,
    at: 'start',
    text: 'ZQ',
    mode: 'map',
  });
  expect(answer).toBe('deferred');
  expect(await h.deferredRemote()).toBe(1);
  expect(await h.bodyText()).not.toContain('ZQ');

  await client.send('Input.insertText', { text: 'に' });
  await expect.poll(() => h.deferredRemote()).toBe(0);
  await expect.poll(async () => (await h.bodyText()).includes('ZQ')).toBe(true);
  expect(await h.bodyText()).toContain('に');
});

test('the bridge is on the painted caret, so an input method window opens there (criterion 3, geometry)', async ({
  page,
}) => {
  await openPageView(page);
  await page.locator('doc-editor .de-page-view .de-line').first().click();
  await page.keyboard.type('x');
  const rects = await page.evaluate(() => {
    const root = document.querySelector('doc-editor')!.shadowRoot!;
    const caret = root.querySelector('.de-page-view .de-caret')!.getBoundingClientRect();
    const bridge = root.querySelector('.de-page-bridge')!.getBoundingClientRect();
    return {
      caret: { left: caret.left, top: caret.top, height: caret.height },
      bridge: { left: bridge.left, top: bridge.top, height: bridge.height },
    };
  });
  expect(Math.abs(rects.bridge.left - rects.caret.left)).toBeLessThan(2);
  expect(Math.abs(rects.bridge.top - rects.caret.top)).toBeLessThan(2);
  expect(Math.abs(rects.bridge.height - rects.caret.height)).toBeLessThan(2);
});
