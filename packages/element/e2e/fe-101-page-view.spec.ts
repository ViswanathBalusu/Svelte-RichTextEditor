/**
 * FE-101: `view="print"` shows the editable page view over the element's one editing core. Run from
 * the repository root with
 * `DOCEDIT_DEMO_PORT=57101 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-101-page-view.spec.ts`.
 *
 * Chromium, Edge and WebKit measure with canvas and offer the page view; Firefox does not (spike S5),
 * so there `view="print"` shows the web view with a notice, and the editing tests are skipped.
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, events, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

/** A desktop pointer: some machines with a touch screen answer `any-pointer: coarse` (FE-113). */
async function desktopPointer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
}

function facts(page: Page) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const surface = root.querySelector<HTMLElement>('.de-editing-surface');
    const pageEls = [...root.querySelectorAll<HTMLElement>('.de-page-view .de-window .de-page')];
    const lines = [...root.querySelectorAll<HTMLElement>('.de-page-view .de-line')];
    const first = pageEls[0]?.getBoundingClientRect();
    return {
      views: root.querySelectorAll('.de-page-view').length,
      pages: pageEls.length,
      lines: lines.length,
      text: lines.map((l) => l.textContent).join('\n'),
      surfaceDisplay: surface ? getComputedStyle(surface).display : null,
      label: root.querySelector('.de-view-label')?.textContent ?? null,
      labelView: root.querySelector<HTMLElement>('.de-view-label')?.dataset['view'] ?? null,
      pageWidth: first ? Math.round(first.width) : null,
      marginLeft:
        first && lines[0] ? Math.round(lines[0].getBoundingClientRect().left - first.left) : null,
      marginTop:
        first && lines[0] ? Math.round(lines[0].getBoundingClientRect().top - first.top) : null,
      pageHeight: first ? Math.round(first.height) : null,
      notice: root.querySelector('.de-view-notice')?.textContent ?? null,
      bridge: root.querySelectorAll('.de-page-bridge').length,
    };
  }, editor);
}

const setView = (page: Page, value: string) =>
  page.evaluate((args) => document.querySelector(args.sel)!.setAttribute('view', args.value), {
    sel: editor,
    value,
  });

test.describe('the editable page view (FE-101)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (S5)');
  });

  test('view="print" shows editable pages with the margins, and the web surface behind (criterion 1)', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'print' } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    const f = await facts(page);
    expect(f.views).toBe(1);
    expect(f.pages).toBeGreaterThanOrEqual(1);
    // The page is as wide as its setup says (A4 is 595.3 pt, which is 793.7 CSS pixels).
    expect(f.pageWidth).toBeGreaterThan(700);
    expect(f.pageHeight).toBeGreaterThan(f.pageWidth!);
    // The margins are the page setup's: 1440 twips is 72 pt, which is 96 CSS pixels.
    expect(f.marginLeft).toBeGreaterThanOrEqual(90);
    expect(f.marginLeft).toBeLessThanOrEqual(100);
    // The header story is in place, with its page number computed by the layout.
    expect(f.text).toMatch(/Header text 1/);
    expect(f.surfaceDisplay).toBe('none');
    expect(f.label).toBe('Page layout');
    expect(f.labelView).toBe('print');
    expect(f.bridge).toBe(1);
    // The painted text is the document's text.
    const body = await bodyText(page);
    const firstWords = body.trim().split(/\s+/).slice(0, 2).join(' ');
    expect(f.text.replace(/\s+/g, ' ')).toContain(firstWords);
    expect(errors).toEqual([]);
  });

  test('typing in the page view changes the document and the pages (criterion 1)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'print' } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    const before = await bodyText(page);
    await page.locator(`${editor} .de-page-view .de-line`).first().click();
    await page.keyboard.type('XYZ');
    await expect.poll(async () => (await bodyText(page)).includes('XYZ')).toBe(true);
    // The pages show it on the next frame, and the text outside it is as it was.
    await expect.poll(async () => (await facts(page)).text.includes('XYZ')).toBe(true);
    const after = await bodyText(page);
    expect(after.replace('XYZ', '')).toBe(before);
    // Backspace inside the block is the browser's, and reaches the document through the bridge.
    await page.keyboard.press('Backspace');
    await expect.poll(async () => (await bodyText(page)).includes('XYZ')).toBe(false);
    expect((await bodyText(page)).includes('XY')).toBe(true);
  });

  test('Enter splits a block and Backspace joins it again, as in the web view (criterion 1)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'print' } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    const blocks = () =>
      page.evaluate(
        (sel) =>
          document
            .querySelector(sel)!
            .shadowRoot!.querySelectorAll('.de-editing-surface :is(p, h1, h2, h3, h4, h5, h6)')
            .length,
        editor,
      );
    const count = await blocks();
    await page.locator(`${editor} .de-page-view .de-line`).first().click();
    await page.keyboard.press('Enter');
    await expect.poll(blocks).toBe(count + 1);
    await page.keyboard.press('Backspace');
    await expect.poll(blocks).toBe(count);
  });

  test('arrow keys move the caret by the layout, and Shift extends it (FE-097)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'print' } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    await page.locator(`${editor} .de-page-view .de-line`).first().click();
    await page.keyboard.press('Control+Home');
    const caretLeft = () =>
      page.evaluate((sel) => {
        const c = document.querySelector(sel)!.shadowRoot!.querySelector('.de-page-view .de-caret');
        return c ? Math.round(c.getBoundingClientRect().left) : null;
      }, editor);
    // The caret is drawn from the selection the browser made, a moment after the keys (WebKit on
    // Linux takes longer than the others): read the start once it has stopped moving.
    await expect
      .poll(async () => {
        const before = await caretLeft();
        await page.waitForTimeout(200);
        return before === (await caretLeft());
      })
      .toBe(true);
    const start = await caretLeft();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(caretLeft).toBeGreaterThan(start!);
    await page.keyboard.press('Shift+ArrowRight');
    await expect
      .poll(() =>
        page.evaluate(
          (sel) =>
            document.querySelector(sel)!.shadowRoot!.querySelectorAll('.de-page-view .de-selection')
              .length,
          editor,
        ),
      )
      .toBeGreaterThan(0);
  });

  test('switching between the web view and the page view keeps the core, the text and the caret (criterion 2)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'web' } });
    await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      (root.querySelector('.de-editing-surface') as HTMLElement & { __kept?: boolean }).__kept =
        true;
    }, editor);

    await setView(page, 'print');
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    await page.locator(`${editor} .de-page-view .de-line`).first().click();
    await page.keyboard.type('AB');
    await expect.poll(async () => (await bodyText(page)).includes('AB')).toBe(true);
    const typed = await bodyText(page);

    await setView(page, 'web');
    await expect.poll(async () => (await facts(page)).views).toBe(0);
    const web = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const s = root.querySelector<HTMLElement & { __kept?: boolean }>('.de-editing-surface')!;
      return { kept: s.__kept === true, shown: s.getBoundingClientRect().height > 0 };
    }, editor);
    expect(web.kept).toBe(true);
    expect(web.shown).toBe(true);
    expect(await bodyText(page)).toBe(typed);
    expect((await facts(page)).label).toBe('Web layout');
    // The caret is where the page view left it: the next letter lands after "AB".
    await page.keyboard.type('Q');
    await expect.poll(async () => (await bodyText(page)).includes('ABQ')).toBe(true);

    await setView(page, 'print');
    await expect.poll(async () => (await facts(page)).text.includes('ABQ')).toBe(true);

    // Unconfirmed work is intact: the commits typed in either view are the session's, and the server
    // confirms them all.
    const confirmed = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement & {
        flush(): Promise<void>;
        getContent(): Promise<{ doc: unknown }>;
      };
      await el.flush();
      return JSON.stringify((await el.getContent()).doc).includes('ABQ');
    }, editor);
    expect(confirmed).toBe(true);
  });

  test('a shortcut sets a mark and the text typed after it carries it (FE-098 criteria 1 and 6)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'print' } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    await page.locator(`${editor} .de-page-view .de-line`).first().click();
    await page.keyboard.press('Control+b');
    await page.keyboard.type('ZZ');
    await expect.poll(async () => (await bodyText(page)).includes('ZZ')).toBe(true);
    const weight = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const walker = document.createTreeWalker(
        root.querySelector('.de-editing-surface')!,
        NodeFilter.SHOW_TEXT,
      );
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n.textContent?.includes('ZZ'))
          return Number.parseInt(getComputedStyle(n.parentElement!).fontWeight, 10);
      return 0;
    }, editor);
    expect(weight).toBeGreaterThanOrEqual(600);
    // The page shows the run in bold, as the layout measured it.
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const runs = [
            ...document
              .querySelector(sel)!
              .shadowRoot!.querySelectorAll<HTMLElement>('.de-page-view .de-run'),
          ];
          return runs.some((r) => r.textContent?.includes('ZZ') && r.style.fontWeight === 'bold');
        }, editor),
      )
      .toBe(true);
  });

  test('a failure of the layout switches to the web view with the work kept and a non-fatal error (criterion 3)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'web' } });
    await page.locator(`${editor} .de-editing-surface p`).first().click();
    await page.keyboard.type('KEEP');
    const typed = await bodyText(page);
    // No canvas: the measurer cannot be made, so the layout cannot start.
    await page.evaluate(() => {
      (window as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = undefined;
      HTMLCanvasElement.prototype.getContext = () => null;
    });
    await setView(page, 'print');
    await expect.poll(async () => (await events(page, 'de-error')).length).toBe(1);
    const [error] = await events(page, 'de-error');
    expect(error!.detail).toMatchObject({ code: 'internal', fatal: false });
    await expect(page.locator(`${editor} .de-editing-surface`)).toBeVisible();
    const f = await facts(page);
    expect(f.views).toBe(0);
    expect(f.label).toBe('Web layout');
    expect(await bodyText(page)).toBe(typed);
    expect(typed).toContain('KEEP');
  });

  test('the shell and its panes work with the page view (criterion 5)', async ({ page }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'print' } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    // The command search is the shell's own key (Alt+Q), and works from the input bridge.
    const view = page.locator(`${editor} .de-page-view`);
    await view.locator('.de-line').first().click();
    await page.keyboard.press('Alt+q');
    const search = page.locator(`${editor} input[role="combobox"]`).first();
    await expect(search).toBeVisible();
    await page.keyboard.type('Navigation');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(page.locator(`${editor} .de-pane`).first()).toBeVisible();
    expect((await facts(page)).views).toBe(1);
  });
});

test('Firefox: view="print" shows the web view and says why (S5)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'firefox', 'this is the Firefox case');
  await desktopPointer(page);
  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'print' } });
  await expect.poll(async () => (await facts(page)).notice).toContain('page view');
  const f = await facts(page);
  expect(f.views).toBe(0);
  expect(f.surfaceDisplay).not.toBe('none');
});
