/**
 * FE-106 criterion 3: a person who needs to zoom has the web view. The page view (FE-101) has fixed
 * width pages and cannot meet the reflow criterion (WCAG 2.2, 1.4.10), so the web view must stay
 * available. In a 320 CSS pixel viewport, `view="print"` shows the web view (the page view is not
 * built, FE-065 criterion 4), and moving through `read` and back to `web` ends in the web view whose
 * paragraphs reflow with no sideways scroll. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-106-web-view-available.spec.ts`.
 *
 * Limit: with no page view, the web view is the only editing view, so this test shows that it is
 * shown and reflows, and that every other `view` value can return to it. When the page view is built,
 * `view="print"` will show pages and this test then checks that the way back to the web view stays.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

test.use({ viewport: { width: 320, height: 700 } });

function facts(page: Page) {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel) as HTMLElement;
    const root = host.shadowRoot!;
    const surface = root.querySelector<HTMLElement>('.de-editing-surface');
    const shell = root.querySelector<HTMLElement>('.de-shell');
    return {
      surface: surface !== null,
      pageView: root.querySelector('.de-page-view') !== null,
      shellShown: shell !== null && getComputedStyle(shell).display !== 'none',
      label: root.querySelector('.de-view-label')?.textContent ?? null,
      pageScrollWidth: document.documentElement.scrollWidth,
      surfaceOverflow: surface ? surface.scrollWidth - surface.clientWidth : null,
      pastEdge: [...(surface?.querySelectorAll('p') ?? [])].filter(
        (p) => p.getBoundingClientRect().right > window.innerWidth + 0.5,
      ).length,
    };
  }, editor);
}

const setView = (page: Page, value: string) =>
  page.evaluate((args) => document.querySelector(args.sel)!.setAttribute('view', args.value), {
    sel: editor,
    value,
  });

test('view="print" at 320 CSS pixels gives the page view, and the web view stays one value away (FE-106, criterion 3)', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'firefox',
    'the page view is not offered in Firefox (S5); fe-065-view-print-fallback.spec.ts covers it',
  );
  // A touch screen makes some browsers answer `any-pointer: coarse`; this test is about a desktop pointer.
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'print' } });

  // The page view (FE-101) shows fixed-width pages, so it is the one view that does not reflow: the way
  // back to the web view is the point of this test.
  await expect.poll(async () => (await facts(page)).label).toBe('Page layout');
  const asked = await facts(page);
  expect(asked.pageView).toBe(true);

  await setView(page, 'web');
  await expect.poll(async () => (await facts(page)).label).toBe('Web layout');
  const web = await facts(page);
  expect(web.pageView).toBe(false);
  expect(web.surfaceOverflow).toBeLessThanOrEqual(0);
  expect(web.pastEdge).toBe(0);

  await setView(page, 'read');
  await expect.poll(async () => (await facts(page)).shellShown).toBe(false);
  await setView(page, 'web');
  await expect.poll(async () => (await facts(page)).shellShown).toBe(true);
  const back = await facts(page);
  expect(back.surface).toBe(true);
  expect(back.label).toBe('Web layout');
  expect(back.surfaceOverflow).toBeLessThanOrEqual(0);
  expect(back.pastEdge).toBe(0);
});
