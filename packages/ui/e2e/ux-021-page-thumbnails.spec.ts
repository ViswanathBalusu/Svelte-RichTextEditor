/**
 * UX-021 in the shell (lane w3, 2026-11-21): the navigation pane's page thumbnails, with a stand-in
 * for the view that has the pages (harness/ux-021-pages.ts). The stand-in says how many pages
 * there are and which is shown, draws a box for a page, and records what the pane asks of it. What
 * a real thumbnail looks like, and the real move of the view, are the element's test with the real
 * page view (packages/element/e2e/ux-021-page-thumbnails.spec.ts).
 *
 * Run from the repository root with
 * `DOCEDIT_BROWSERS=chromium,firefox,webkit,msedge pnpm exec playwright test -c packages/ui/playwright.config.ts ux-021-page-thumbnails`.
 */
import type { Locator, Page } from '@playwright/test';
import { axe, expect, open, test } from './helpers.ts';

/** Opens the navigation pane and, with `pages`, its Pages tab. */
async function openPages(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: 'Pages' }).click();
  const list = page.getByRole('listbox', { name: 'Pages' });
  await expect(list).toBeVisible();
  return list;
}

/** The page numbers of the options in the DOM, in order. */
const inDom = (list: Locator): Promise<number[]> =>
  list
    .getByRole('option')
    .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset['page']) + 1));

/** The drawing of the page of an option: the element just before it in its thumbnail. */
const drawingOf = (option: Locator): Locator => option.locator('xpath=preceding-sibling::*[1]');

/** Whether an option lies whole inside the list's own box. */
async function wholeInList(list: Locator, option: Locator): Promise<boolean> {
  const a = await option.boundingBox();
  const b = await list.boundingBox();
  if (!a || !b) return false;
  return a.y >= b.y - 1 && a.y + a.height <= b.y + b.height + 1;
}

test.describe('the web view has no pages (UX-021 criterion 3)', () => {
  test('the pane is the headings alone: no tab and no thumbnail', async ({ page }) => {
    const h = await open(page, { extended: true });
    await h.exec('view.outline');
    await expect(page.getByRole('tree', { name: 'Headings' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Navigate by' })).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: 'Pages' })).toHaveCount(0);
    await expect(page.locator('.de-thumb')).toHaveCount(0);
    expect((await h.pagesLog()).paints).toEqual([]);
  });

  test('the tabs and the thumbnails go when the view that had pages is no longer shown', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 8 });
    await h.exec('view.outline');
    const list = await openPages(page);
    await expect(list.getByRole('option').first()).toBeVisible();
    // The view on screen becomes the web view.
    await h.setPages(null);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: 'Pages' })).toHaveCount(0);
    await expect(page.getByRole('tree', { name: 'Headings' })).toBeVisible();
    // And they are back when a view with pages is shown again, on the tab the author had chosen.
    await h.setPages({ count: 8 });
    await expect(page.getByRole('tab', { name: 'Pages' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('listbox', { name: 'Pages' })).toBeVisible();
  });
});

test.describe('a view with pages (UX-021)', () => {
  test('the pane has two tabs, headings first, and they follow the tabs pattern', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 12 });
    await h.exec('view.outline');
    const tabs = page.getByRole('tablist', { name: 'Navigate by' });
    await expect(tabs.getByRole('tab')).toHaveText(['Headings', 'Pages']);
    const headings = tabs.getByRole('tab', { name: 'Headings' });
    const pagesTab = tabs.getByRole('tab', { name: 'Pages' });
    await expect(headings).toHaveAttribute('aria-selected', 'true');
    await expect(pagesTab).toHaveAttribute('aria-selected', 'false');
    // The panel is the headings, labelled by its tab.
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAccessibleName('Headings');
    await expect(panel.getByRole('tree', { name: 'Headings' })).toBeVisible();
    expect(await headings.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
    // One tab stop; the arrows move between the tabs and show the tab they reach.
    await expect(headings).toHaveAttribute('tabindex', '0');
    await expect(pagesTab).toHaveAttribute('tabindex', '-1');
    await headings.focus();
    await page.keyboard.press('ArrowRight');
    await expect(pagesTab).toBeFocused();
    await expect(pagesTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveAccessibleName('Pages');
    await expect(panel.getByRole('listbox', { name: 'Pages' })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(headings).toBeFocused();
    await expect(panel.getByRole('tree', { name: 'Headings' })).toBeVisible();
    await page.keyboard.press('End');
    await expect(pagesTab).toBeFocused();
    await page.keyboard.press('Home');
    await expect(headings).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });

  test('each thumbnail is named "Page n of m", and its drawing is hidden from assistive technology (criterion 4)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 12 });
    await h.exec('view.outline');
    const list = await openPages(page);
    const first = list.getByRole('option', { name: 'Page 1 of 12', exact: true });
    await expect(first).toBeVisible();
    await expect(first).toHaveAccessibleName('Page 1 of 12');
    await expect(list.getByRole('option', { name: 'Page 2 of 12', exact: true })).toBeVisible();
    // Its place in the whole set, though only some of the set is in the DOM.
    await expect(first).toHaveAttribute('aria-setsize', '12');
    await expect(first).toHaveAttribute('aria-posinset', '1');
    // The option is the page number, which is what the eye reads and is part of the name. The
    // drawing is beside it, hidden from assistive technology and inert: it is not read.
    const parts = await first.evaluate((o) => {
      const drawing = o.previousElementSibling;
      return {
        visible: o.textContent?.trim(),
        drawing: drawing?.className,
        hidden: drawing?.getAttribute('aria-hidden'),
        inert: drawing?.hasAttribute('inert'),
        drawn: drawing?.querySelector('[data-sheet]')?.textContent,
        inOption: o.querySelector('[data-sheet]') !== null,
        wrapper: o.parentElement?.getAttribute('role'),
      };
    });
    expect(parts).toEqual({
      visible: '1',
      drawing: 'de-thumb-page',
      hidden: 'true',
      inert: true,
      drawn: 'Sheet 1',
      inOption: false,
      wrapper: 'presentation',
    });
    // A pointer target of at least 24 by 24 CSS pixels.
    // The boxes of Firefox come in single precision, which gives 23.99997 for a box of 24px
    // (seen on Linux); the stylesheet sets the size to 24px, so the tolerance is the rounding.
    const box = (await first.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24 - 0.001);
    expect(box.height).toBeGreaterThanOrEqual(24 - 0.001);
    expect(await axe(page)).toEqual([]);
  });

  test('the name is in the locale in use, and a host may replace it (criterion 4)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 5, locale: 'en-XA' });
    await h.exec('view.outline');
    await page.getByRole('tab').nth(1).click();
    const options = page.getByRole('listbox').getByRole('option');
    // The pseudo-locale's letters, with the numbers in their places.
    await expect(options.nth(1)).toHaveAccessibleName(/Þáĝé 2 óƒ 5/);
    await expect(options.nth(1)).not.toHaveAccessibleName(/Page/);

    const replaced = await open(page, {
      extended: true,
      pages: 5,
      overrides: { 'pages.thumbnail': 'Seite {page} von {pages}', 'pages.label': 'Seiten' },
    });
    await replaced.exec('view.outline');
    await page.getByRole('tab', { name: 'Seiten' }).click();
    await expect(
      page.getByRole('listbox', { name: 'Seiten' }).getByRole('option').nth(2),
    ).toHaveAccessibleName('Seite 3 von 5');
  });

  test('of a thousand pages only those near what the list shows are in the DOM (criterion 1)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 1000 });
    await h.exec('view.outline');
    const list = await openPages(page);
    await expect(list).toHaveAttribute('data-pages', '1000');
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-setsize', '1000');
    // At the top: the first few, in order, and nothing else.
    const atTop = await inDom(list);
    expect(atTop.length).toBeGreaterThan(0);
    expect(atTop.length).toBeLessThanOrEqual(9);
    expect(atTop).toEqual(atTop.map((_, i) => i + 1));
    // The list is as tall as a thousand thumbnails, though it holds a handful.
    const sizes = await list.evaluate((l) => ({ scroll: l.scrollHeight, client: l.clientHeight }));
    expect(sizes.scroll).toBeGreaterThan(150 * 1000);
    expect(sizes.client).toBeLessThan(700);
    expect((await h.pagesLog()).paints.every((p) => p < 9)).toBe(true);

    // In the middle: the pages there, and the one with the tab stop, which is kept wherever it is.
    await list.evaluate((l) => (l.scrollTop = l.scrollHeight / 2));
    await expect(list.getByRole('option', { name: 'Page 1 of 1,000', exact: true })).toHaveCount(1);
    await expect.poll(async () => (await inDom(list)).some((n) => n > 400 && n < 600)).toBe(true);
    const inMiddle = await inDom(list);
    expect(inMiddle.length).toBeLessThanOrEqual(10);
    expect(inMiddle.filter((n) => n !== 1).every((n) => n > 400 && n < 600)).toBe(true);
    await expect(list.getByRole('option', { name: 'Page 2 of 1,000', exact: true })).toHaveCount(0);

    // At the end: the last pages; those of the middle are gone.
    await list.evaluate((l) => (l.scrollTop = l.scrollHeight));
    await expect(
      list.getByRole('option', { name: 'Page 1,000 of 1,000', exact: true }),
    ).toBeVisible();
    const atEnd = await inDom(list);
    expect(atEnd.length).toBeLessThanOrEqual(10);
    expect(atEnd.filter((n) => n !== 1).every((n) => n > 990)).toBe(true);
    // No more was drawn than was in the DOM along the way.
    const paints = new Set((await h.pagesLog()).paints);
    expect(paints.size).toBeLessThan(60);
    expect(paints.has(250)).toBe(false);
  });

  test('choosing a thumbnail moves the view to that page, and the page shown is marked (criterion 2)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 12 });
    await h.exec('view.outline');
    const list = await openPages(page);
    const option = (n: number) =>
      list.getByRole('option', { name: `Page ${n} of 12`, exact: true });
    // The page the view shows is the selected one, and the only one.
    await expect(option(1)).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);

    // A click on the drawing of page 3, as a person points at it. The drawing is inert, so the
    // pointer is put on it by its place and not through a locator.
    await option(3).scrollIntoViewIfNeeded();
    const drawing = (await drawingOf(option(3)).boundingBox())!;
    await page.mouse.click(drawing.x + drawing.width / 2, drawing.y + drawing.height / 2);
    expect((await h.pagesLog()).goTo).toEqual([2]);
    await expect(option(3)).toHaveAttribute('aria-selected', 'true');
    await expect(option(1)).toHaveAttribute('aria-selected', 'false');
    await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
    // The option of the page that was pointed at has the focus, as after a key.
    await expect(option(3)).toBeFocused();
    // Marked for the eye by more than a colour: a heavier frame and a heavier number.
    const mark = (n: number) =>
      option(n).evaluate((o) => {
        const sheet = getComputedStyle(o.previousElementSibling!);
        const number = getComputedStyle(o);
        return {
          frame: sheet.outlineWidth,
          weight: Number(number.fontWeight),
          underline: number.textDecorationLine,
        };
      });
    expect(await mark(3)).toEqual({ frame: '3px', weight: 700, underline: 'underline' });
    expect(await mark(2)).toEqual({ frame: '1px', weight: 400, underline: 'none' });

    // The view moves by itself (the author scrolls the document): the mark follows, and the list
    // brings that thumbnail into view.
    await h.setPages({ current: 10 });
    await expect(option(11)).toHaveAttribute('aria-selected', 'true');
    await expect(option(3)).toHaveAttribute('aria-selected', 'false');
    await expect.poll(async () => wholeInList(list, option(11))).toBe(true);
    await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
    expect((await h.pagesLog()).goTo).toEqual([2]);
  });

  test('the tab stop follows the page shown while the author is elsewhere', async ({ page }) => {
    const h = await open(page, { extended: true, pages: 40 });
    await h.exec('view.outline');
    const list = await openPages(page);
    // Focus is on the tab, not in the list.
    await h.setPages({ current: 25 });
    const shown = list.getByRole('option', { name: 'Page 26 of 40', exact: true });
    await expect(shown).toHaveAttribute('aria-selected', 'true');
    await expect(shown).toHaveAttribute('tabindex', '0');
    await expect(list.locator('[role="option"][tabindex="0"]')).toHaveCount(1);
    // The thumbnail that had the tab stop is no longer near what the list shows, and is gone.
    await expect(list.getByRole('option', { name: 'Page 1 of 40', exact: true })).toHaveCount(0);
    await expect.poll(async () => wholeInList(list, shown)).toBe(true);
  });

  test('the list is worked from the keyboard: the arrows, Home, End, Page keys, Enter and Space', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 30 });
    await h.exec('view.outline');
    const list = await openPages(page);
    const option = (n: number) =>
      list.getByRole('option', { name: `Page ${n} of 30`, exact: true });
    // One tab stop: the page shown. Tab reaches it from the tab.
    await expect(list.locator('[role="option"][tabindex="0"]')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Pages' }).focus();
    await page.keyboard.press('Tab');
    await expect(option(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(option(2)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(option(3)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(option(2)).toBeFocused();
    // Moving does not move the view; choosing does.
    expect((await h.pagesLog()).goTo).toEqual([]);
    await page.keyboard.press('Enter');
    expect((await h.pagesLog()).goTo).toEqual([1]);
    await expect(option(2)).toHaveAttribute('aria-selected', 'true');
    await expect(option(2)).toBeFocused();
    // End and Home reach pages that were not in the DOM, and the list scrolls to them.
    await page.keyboard.press('End');
    await expect(option(30)).toBeFocused();
    expect(await wholeInList(list, option(30))).toBe(true);
    await page.keyboard.press(' ');
    expect((await h.pagesLog()).goTo).toEqual([1, 29]);
    await expect(option(30)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(option(1)).toBeFocused();
    expect(await wholeInList(list, option(1))).toBe(true);
    // A page key moves by what fits in the list: further than one, and not out of it.
    await page.keyboard.press('PageDown');
    const after = await page.evaluate(() => {
      const active = document.getElementById('host')!.shadowRoot!.activeElement as HTMLElement;
      return Number(active.dataset['page']) + 1;
    });
    expect(after).toBeGreaterThan(1);
    expect(after).toBeLessThan(12);
    await page.keyboard.press('PageUp');
    await expect(option(1)).toBeFocused();
    await expect(list.locator('[role="option"][tabindex="0"]')).toHaveCount(1);
    // While the author is in the list, a move of the view does not take the place away.
    await page.keyboard.press('ArrowDown');
    await h.setPages({ current: 20 });
    await expect(option(2)).toBeFocused();
  });

  test('a new layout draws the thumbnails again after a pause, not at every change', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, pages: 6 });
    await h.exec('view.outline');
    const list = await openPages(page);
    const layoutOf = (n: number) =>
      drawingOf(list.getByRole('option', { name: `Page ${n} of 6`, exact: true }))
        .locator('[data-sheet]')
        .getAttribute('data-layout');
    await expect.poll(() => layoutOf(1)).toBe('1');
    const before = (await h.pagesLog()).paints.length;
    // Three layouts in a row, as three keys would give.
    await h.setPages({ revision: 2 });
    await h.setPages({ revision: 3 });
    await h.setPages({ revision: 4 });
    expect((await h.pagesLog()).paints.length).toBe(before);
    expect(await layoutOf(1)).toBe('1');
    // Once the pages have stayed as they are, each thumbnail in the DOM is drawn once more.
    await expect.poll(() => layoutOf(1)).toBe('4');
    const drawnAgain = (await h.pagesLog()).paints.length - before;
    expect(drawnAgain).toBe((await inDom(list)).length);
  });
});
