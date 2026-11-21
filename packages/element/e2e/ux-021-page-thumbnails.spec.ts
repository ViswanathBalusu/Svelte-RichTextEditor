/**
 * UX-021 in the product's element (lane w3, 2026-11-21): the navigation pane's page thumbnails in
 * the page view (`view="print"`), with the real core, the real layout and the real painter, and
 * backend-mock in the page. The document is the embed page's with 240 paragraphs of five lines
 * added, which the layout sets on some thirty pages.
 *
 * - Criterion 1: of those pages only the thumbnails near what the list shows are in the DOM, and
 *   each is the page itself, painted from the layout tree and scaled down.
 * - Criterion 2: choosing a thumbnail, with the pointer or a key, puts that page at the top of the
 *   view and the caret on it, and the page the view shows is the marked one, also after the author
 *   scrolls the document.
 * - Criterion 3: the web view offers no thumbnails; they come and go with the `view` attribute.
 * - Criterion 4: a thumbnail is named "Page n of m" in the locale in use, and the page's text in
 *   the drawing is not offered to assistive technology.
 *
 * Chromium, Edge and WebKit offer the page view. Firefox does not (spike S5): there `view="print"`
 * shows the web view, so the one Firefox test is that no thumbnail is offered.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts ux-021-page-thumbnails`.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'ux021';
const EDITOR = `doc-editor[data-test="${NAME}"]`;
const PARAGRAPHS = 240;

/** A desktop pointer: some machines with a touch screen answer `any-pointer: coarse` (FE-113). */
async function desktopPointer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
}

interface Embed {
  service: {
    createDocument(content: unknown, opts?: { grants?: unknown[] }): string;
    backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
  };
  docId: string;
  internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } | null };
}

/**
 * Creates the long document in the page's service and mounts an editor on it with the attributes
 * given. Resolves when the editor is ready.
 */
async function mountLong(page: Page, attributes: Record<string, string> = {}): Promise<void> {
  await page.evaluate(
    async ({ name, attributes, paragraphs }) => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      type Port = {
        connect(): Promise<void>;
        sync: {
          loadContent(id: string): Promise<{
            cdm: number;
            requires: string[];
            doc: { content: Array<{ type: string; content: unknown[] }> };
          }>;
        };
      };
      const reader = e.service.backend(
        { sub: 'olga', name: 'Olga' },
        { [e.docId]: 'owner' },
      ) as Port;
      await reader.connect();
      const source = await reader.sync.loadContent(e.docId);
      const body = source.doc.content.find((n) => n.type === 'body')!;
      const sentence =
        'The quick brown fox jumps over the lazy dog while the editor lays this line out on a page. ';
      for (let i = 1; i <= paragraphs; i++)
        body.content.push({
          type: 'paragraph',
          attrs: { id: `pLong${String(i).padStart(11, '0')}`, style: 'Normal' },
          content: [{ type: 'text', text: `Para ${i}: ${sentence.repeat(5).trim()}` }],
        });
      const docId = e.service.createDocument({
        cdm: source.cdm,
        requires: source.requires,
        doc: source.doc,
      });
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      for (const [attribute, value] of Object.entries(attributes))
        el.setAttribute(attribute, value);
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [docId]: 'editor' });
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { name: NAME, attributes, paragraphs: PARAGRAPHS },
  );
}

/** Waits until the page view has painted its pages. */
async function pagesPainted(page: Page): Promise<void> {
  await expect(page.locator(`${EDITOR} .de-page-view .de-window .de-page`).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Opens the navigation pane as its command does. */
async function openNavigation(page: Page): Promise<void> {
  const opened = await page.evaluate((selector) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    return e.internals(document.querySelector(selector)!).editor!.openPane('outline');
  }, EDITOR);
  expect(opened).toBe(true);
  await expect(page.locator(`${EDITOR} .de-outline`)).toBeVisible();
}

/** Shows the Pages tab and gives its list. */
async function openPages(page: Page): Promise<Locator> {
  await openNavigation(page);
  await page.locator(EDITOR).getByRole('tab', { name: 'Pages' }).click();
  const list = page.locator(EDITOR).getByRole('listbox', { name: 'Pages' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toBeVisible();
  return list;
}

const setView = (page: Page, value: string) =>
  page.evaluate((args) => document.querySelector(args.sel)!.setAttribute('view', args.value), {
    sel: EDITOR,
    value,
  });

/** How many pages the list says the view has. */
const pageCount = async (list: Locator): Promise<number> =>
  Number(await list.getAttribute('data-pages'));

/** The page numbers of the options in the DOM, in order. */
const inDom = (list: Locator): Promise<number[]> =>
  list
    .getByRole('option')
    .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset['page']) + 1));

/** The drawing of the page of an option: the element just before it in its thumbnail. */
const drawingOf = (option: Locator): Locator => option.locator('xpath=preceding-sibling::*[1]');

/** The page view's scroller, and where its pages are in it. */
function view(page: Page) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector)!.shadowRoot!;
    const scroller = root.querySelector<HTMLElement>('.de-page-scroller')!;
    const box = scroller.getBoundingClientRect();
    const mounted = [
      ...root.querySelectorAll<HTMLElement>('.de-page-view .de-window .de-page'),
    ].map((el) => ({
      page: Number(el.dataset['page']) + 1,
      // Where the page's top is, from the top of what the scroller shows.
      top: Math.round(el.getBoundingClientRect().top - box.top),
      caret: el.querySelector('.de-caret') !== null,
      firstLine: el.querySelector('.de-line')?.textContent ?? '',
    }));
    return { scrollTop: Math.round(scroller.scrollTop), height: scroller.clientHeight, mounted };
  }, EDITOR);
}

/** Clicks the drawing of an option's page by its place: the drawing is inert, so no locator click. */
async function clickDrawing(page: Page, option: Locator): Promise<void> {
  await option.scrollIntoViewIfNeeded();
  const box = (await drawingOf(option).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe('page thumbnails in the page view (UX-021)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (S5)');
  });

  test('only the thumbnails near what the list shows are in the DOM, and each is its page, painted from the layout (criterion 1)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountLong(page, { view: 'print' });
    await pagesPainted(page);
    const list = await openPages(page);
    const pages = await pageCount(list);
    expect(pages).toBeGreaterThan(20);
    // A handful of the pages, the first ones, and no other.
    const atTop = await inDom(list);
    expect(atTop.length).toBeGreaterThan(1);
    expect(atTop.length).toBeLessThanOrEqual(9);
    expect(atTop).toEqual(atTop.map((_, i) => i + 1));
    await expect(list.locator('.de-thumb-sheet')).toHaveCount(atTop.length);

    // A thumbnail is the page: the painter's lines, scaled to the thumbnail's width.
    const option = (n: number) =>
      list.getByRole('option', { name: `Page ${n} of ${pages}`, exact: true });
    const thumb = (n: number) =>
      drawingOf(option(n)).evaluate((d) => {
        const sheet = d.querySelector<HTMLElement>('.de-thumb-sheet')!;
        const box = d.getBoundingClientRect();
        const drawn = sheet.getBoundingClientRect();
        const body = [...sheet.querySelectorAll('.de-line')]
          .map((l) => l.textContent ?? '')
          .find((t) => t.startsWith('Para '));
        return {
          lines: sheet.querySelectorAll('.de-line').length,
          width: Math.round(box.width),
          // The drawn page fills the thumbnail: its scaled size is the thumbnail's.
          fills: Math.abs(drawn.width - box.width) < 1.5 && Math.abs(drawn.height - box.height) < 2,
          // The page's own size, before the scale: far larger than the thumbnail.
          pageWidth: Math.round(sheet.offsetWidth),
          firstBody: body ?? '',
          cls: sheet.className,
          marked: sheet.hasAttribute('data-page'),
        };
      });
    const second = await thumb(2);
    expect(second.lines).toBeGreaterThan(20);
    expect(second.width).toBe(120);
    expect(second.fills).toBe(true);
    expect(second.pageWidth).toBeGreaterThan(700);
    // Not the shell's `.de-page`, and not counted as a page of the view.
    expect(second.cls).toBe('de-thumb-sheet');
    expect(second.marked).toBe(false);
    // The thumbnail of page 2 starts with the text page 2 of the view starts with.
    await page.locator(`${EDITOR} .de-page-scroller`).evaluate((s, top) => (s.scrollTop = top), 1);
    const shown = await view(page);
    const pageTwo = shown.mounted.find((m) => m.page === 2);
    expect(pageTwo).toBeDefined();
    const bodyOfPageTwo = await page.evaluate((selector) => {
      const root = document.querySelector(selector)!.shadowRoot!;
      const el = root.querySelector('.de-page-view .de-window .de-page[data-page="1"]')!;
      return (
        [...el.querySelectorAll('.de-line')]
          .map((l) => l.textContent ?? '')
          .find((t) => t.startsWith('Para ')) ?? ''
      );
    }, EDITOR);
    expect(bodyOfPageTwo).toMatch(/^Para \d+:/);
    expect(second.firstBody).toBe(bodyOfPageTwo);
    expect((await thumb(1)).firstBody).not.toBe(second.firstBody);

    // The list is as tall as all the pages; scrolled to its end it holds the last ones.
    const sizes = await list.evaluate((l) => ({ scroll: l.scrollHeight, client: l.clientHeight }));
    expect(sizes.scroll).toBeGreaterThan(pages * 150);
    await list.evaluate((l) => (l.scrollTop = l.scrollHeight));
    await expect(option(pages)).toBeVisible();
    const atEnd = await inDom(list);
    expect(atEnd.length).toBeLessThanOrEqual(10);
    // The first page keeps the list's tab stop, so it stays; the pages between are not there.
    expect(atEnd.filter((n) => n !== 1).every((n) => n > pages - 9)).toBe(true);
    await expect(list.locator('.de-thumb-sheet')).toHaveCount(atEnd.length);
    expect((await thumb(pages)).lines).toBeGreaterThan(0);
  });

  test('choosing a thumbnail moves the view to that page, and the page shown is marked (criterion 2)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountLong(page, { view: 'print' });
    await pagesPainted(page);
    const list = await openPages(page);
    const pages = await pageCount(list);
    const option = (n: number) =>
      list.getByRole('option', { name: `Page ${n} of ${pages}`, exact: true });
    const selected = () =>
      list
        .locator('[role="option"][aria-selected="true"]')
        .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset['page']) + 1));
    /** Page `n` is at the top of what the view shows, within a few pixels, with the caret on it. */
    const atTop = async (n: number) => {
      const v = await view(page);
      const p = v.mounted.find((m) => m.page === n);
      return p ? { top: Math.abs(p.top) <= 4, caret: p.caret } : { top: false, caret: false };
    };
    expect(await selected()).toEqual([1]);

    // With the pointer, on the drawing.
    await clickDrawing(page, option(3));
    await expect.poll(() => atTop(3)).toEqual({ top: true, caret: true });
    await expect.poll(selected).toEqual([3]);
    await expect(drawingOf(option(3)).locator('xpath=..')).toHaveAttribute('data-current', '');

    // With the keys: two thumbnails down from the one chosen, then Enter.
    await expect(option(3)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(option(5)).toBeFocused();
    expect(await selected()).toEqual([3]);
    await page.keyboard.press('Enter');
    await expect.poll(() => atTop(5)).toEqual({ top: true, caret: true });
    await expect.poll(selected).toEqual([5]);

    // The view stays on the page: a later frame does not bring it back to where the caret was.
    await page.waitForTimeout(300);
    expect(await atTop(5)).toEqual({ top: true, caret: true });

    // Typing goes into the page that was chosen, at the start of its text, and the view stays.
    const before = (await view(page)).mounted.find((m) => m.page === 5)!.firstLine;
    await page.locator(`${EDITOR} .de-page-bridge`).focus();
    await page.keyboard.type('ZQ');
    await expect
      .poll(async () => (await view(page)).mounted.find((m) => m.page === 5)?.firstLine ?? '')
      .not.toBe(before);
    const after = (await view(page)).mounted.find((m) => m.page === 5)!;
    expect(Math.abs(after.top)).toBeLessThanOrEqual(4);

    // The author scrolls the document: the mark follows the page the view shows, and the list
    // brings that thumbnail into view.
    const tenth = await page.evaluate((selector) => {
      const root = document.querySelector(selector)!.shadowRoot!;
      const scroller = root.querySelector<HTMLElement>('.de-page-scroller')!;
      // Nine pages down, by the height of a page and the gap of 12 points between two, and a
      // little more, so that the tenth page fills what the view shows.
      const one = root.querySelector<HTMLElement>('.de-page-view .de-window .de-page')!;
      scroller.scrollTop = (one.offsetHeight + 16) * 9 + 40;
      return scroller.scrollTop;
    }, EDITOR);
    expect(tenth).toBeGreaterThan(5000);
    await expect.poll(selected).toEqual([10]);
    await expect(option(10)).toBeVisible();
    const inList = await (async () => {
      const a = (await option(10).boundingBox())!;
      const b = (await list.boundingBox())!;
      return a.y >= b.y - 1 && a.y + a.height <= b.y + b.height + 1;
    })();
    expect(inList).toBe(true);
  });

  test('a thumbnail is named "Page n of m", in the locale in use, and the page text in it is not offered to assistive technology (criterion 4)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountLong(page, { view: 'print' });
    await pagesPainted(page);
    const list = await openPages(page);
    const pages = await pageCount(list);
    const second = list.getByRole('option', { name: `Page 2 of ${pages}`, exact: true });
    await expect(second).toHaveAccessibleName(`Page 2 of ${pages}`);
    await expect(second).toHaveAttribute('aria-setsize', String(pages));
    await expect(second).toHaveAttribute('aria-posinset', '2');
    await expect(second).toHaveText('2');
    // The drawing holds the page's text for the eye only.
    const drawing = drawingOf(second);
    await expect(drawing).toHaveAttribute('aria-hidden', 'true');
    expect(await drawing.evaluate((d) => d.hasAttribute('inert'))).toBe(true);
    expect(await drawing.evaluate((d) => (d.textContent ?? '').includes('Para '))).toBe(true);
    // What assistive technology is given of the list: the options by name, and no page text.
    const tree = await list.ariaSnapshot();
    expect(tree).toContain(`option "Page 2 of ${pages}"`);
    expect(tree).not.toContain('Para ');
    expect(tree).not.toContain('quick brown fox');

    // Another locale: the pseudo-locale's letters, with the numbers in their places.
    await page.evaluate((selector) => {
      document.querySelector(selector)!.setAttribute('locale', 'en-XA');
    }, EDITOR);
    const options = page.locator(EDITOR).getByRole('listbox').getByRole('option');
    await expect(options.nth(1)).toHaveAccessibleName(new RegExp(`Þáĝé 2 óƒ ${pages}`));
  });

  test('the web view offers no thumbnails; they come and go with the view (criterion 3)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountLong(page);
    await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
    await openNavigation(page);
    const editor = page.locator(EDITOR);
    // The web view: the headings alone.
    await expect(editor.getByRole('tree', { name: 'Headings' })).toBeVisible();
    await expect(editor.getByRole('tab')).toHaveCount(0);
    await expect(editor.getByRole('listbox', { name: 'Pages' })).toHaveCount(0);
    await expect(editor.locator('.de-thumb')).toHaveCount(0);

    // The page view: the tabs are there, and the Pages tab lists thumbnails.
    await setView(page, 'print');
    await pagesPainted(page);
    await expect(editor.getByRole('tab')).toHaveText(['Headings', 'Pages']);
    await editor.getByRole('tab', { name: 'Pages' }).click();
    await expect(
      editor.getByRole('listbox', { name: 'Pages' }).getByRole('option').first(),
    ).toBeVisible();

    // Back in the web view: no tab, no thumbnail, and the headings again.
    await setView(page, 'web');
    await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
    await expect(editor.getByRole('tab')).toHaveCount(0);
    await expect(editor.getByRole('listbox', { name: 'Pages' })).toHaveCount(0);
    await expect(editor.locator('.de-thumb')).toHaveCount(0);
    await expect(editor.getByRole('tree', { name: 'Headings' })).toBeVisible();
  });
});

test('where the page view is not offered, `view="print"` is the web view and offers no thumbnails (UX-021 criterion 3)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'firefox', 'the browsers that offer the page view are tested above');
  await desktopPointer(page);
  await openEmbed(page);
  await mountLong(page, { view: 'print' });
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
  await openNavigation(page);
  const editor = page.locator(EDITOR);
  await expect(editor.getByRole('tree', { name: 'Headings' })).toBeVisible();
  await expect(editor.getByRole('tab')).toHaveCount(0);
  await expect(editor.getByRole('listbox', { name: 'Pages' })).toHaveCount(0);
  await expect(editor.locator('.de-page-view')).toHaveCount(0);
});
