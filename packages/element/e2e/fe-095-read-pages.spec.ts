/**
 * FE-095 criterion 1: with `config.readPages`, `view="read"` paints the layout engine's pages
 * read-only: no editing surface and no input bridge in the pages. Without the switch, `view="read"`
 * is the typeset PDF read view as before (FE-072). Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57095 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-095-read-pages.spec.ts`.
 *
 * Chromium, Edge and WebKit measure with canvas and offer the page view; Firefox does not (spike S5),
 * so there the PDF read view stays and the painted-pages tests are skipped.
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

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
    const view = root.querySelector<HTMLElement>('.de-page-view');
    const lines = [...root.querySelectorAll<HTMLElement>('.de-page-view .de-line')];
    return {
      views: root.querySelectorAll('.de-page-view').length,
      readOnly: view?.dataset['readonly'] ?? null,
      lines: lines.length,
      text: lines.map((l) => l.textContent).join('\n'),
      bridges: root.querySelectorAll('.de-page-bridge').length,
      inputs: view ? view.querySelectorAll('textarea, input, [contenteditable]').length : -1,
      label: root.querySelector('.de-view-label')?.textContent ?? null,
      pdfReadViews: root.querySelectorAll('.de-read-view').length,
    };
  }, editor);
}

test.describe('read-only pages for view="read" (FE-095)', () => {
  test('paints the pages with no editing surface and no input bridge (criterion 1)', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (S5)');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, { attributes: { view: 'read' }, config: { readPages: true } });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    const f = await facts(page);
    expect(f.views).toBe(1);
    expect(f.readOnly).toBe('true');
    expect(f.label).toBe('Reading layout');
    // Nothing in the pages takes input or focus.
    expect(f.bridges).toBe(0);
    expect(f.inputs).toBe(0);
    expect(f.pdfReadViews).toBe(0);
    // The pages hold the document's text.
    const body = await bodyText(page);
    expect(f.text.replace(/\s+/g, ' ')).toContain(body.trim().split(/\s+/).slice(0, 3).join(' '));
    // Typing does not change the document, and nothing takes the keys.
    const before = await bodyText(page);
    await page.locator(`${editor} .de-page-view .de-line`).first().click();
    await page.keyboard.type('Zed');
    expect(await bodyText(page)).toBe(before);
    expect(errors).toEqual([]);
  });

  test('the control for the accessible web layout keeps the reader from editing', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (S5)');
    await desktopPointer(page);
    await openEmbed(page);
    await mountEditor(page, {
      attributes: { view: 'read', mode: 'edit' },
      config: { readPages: true },
    });
    await expect.poll(async () => (await facts(page)).lines).toBeGreaterThan(0);
    const toWeb = page.locator(`${editor} .de-view-switch`);
    await expect(toWeb).toHaveText('Use the accessible web layout');
    await toWeb.click();
    await expect.poll(async () => (await facts(page)).views).toBe(0);
    const before = await bodyText(page);
    await page.keyboard.type('Zed');
    expect(await bodyText(page)).toBe(before);
    const editable = await page.evaluate(
      (sel) =>
        document
          .querySelector(sel)!
          .shadowRoot!.querySelector('.de-body-host [contenteditable]')
          ?.getAttribute('contenteditable') ?? null,
      editor,
    );
    expect(editable === null || editable === 'false').toBe(true);
    await page.locator(`${editor} .de-view-switch`).click();
    await expect.poll(async () => (await facts(page)).readOnly).toBe('true');
  });
});
