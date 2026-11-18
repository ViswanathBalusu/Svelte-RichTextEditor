/**
 * UX-061, criterion 2, on the mounted element (lane w3): with a run of text in an authored colour
 * in the real document, switching the theme and the page canvas (dark with the canvas following, dark
 * with the page left light, light) changes the page's background and nothing the document holds. The
 * stored document on the server and the editing core's own copy are the same text before and after,
 * the authored colour is still in them, and the run is drawn in that colour in every state, not in a
 * colour the theme chose. The export half is in packages/ui/e2e/ux-061-export-theme.spec.ts.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const AUTHORED = '#C00000';
const TEXT = 'Last paragraph.';

type Embed = {
  docId: string;
  service: { document(id: string): { content(): unknown } };
  internals(el: Element): {
    editor: { core: { run(name: string, args: object): boolean; getContent(): unknown } };
    settings: { set(patch: Record<string, unknown>): void };
  };
};

const stored = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    return JSON.stringify(e.service.document(e.docId).content());
  });

const held = (page: Page, sel: string): Promise<string> =>
  page.evaluate((s) => {
    const e = (window as unknown as { __embed: Embed }).__embed;
    return JSON.stringify(e.internals(document.querySelector(s)!).editor.core.getContent());
  }, sel);

/** The page's background and the colour the authored run is drawn in. */
const drawn = (page: Page) =>
  page.evaluate(
    ({ sel, text }) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const p = [...root.querySelectorAll('.de-editing-surface p')].find((x) =>
        (x.textContent ?? '').includes(text),
      )!;
      const run = [...p.querySelectorAll('span')].find((x) => (x.textContent ?? '').includes(text));
      const shell = root.querySelector('.de-shell')!;
      const sheet = root.querySelector('.de-page')!;
      return {
        theme: shell.getAttribute('data-theme'),
        pageTheme: shell.getAttribute('data-page-theme'),
        page: getComputedStyle(sheet).backgroundColor,
        run: getComputedStyle(run ?? p).color,
      };
    },
    { sel: editor, text: TEXT },
  );

test.describe('UX-061 the theme does not change the document on the mounted element', () => {
  test('keeps the stored document and the authored colour, in the dark theme with and without the page canvas', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { theme: 'light' } });
    // Colour a run of the real document, as an author would, and wait until the server has it.
    await page
      .locator(`${editor} .de-editing-surface p`, { hasText: TEXT })
      .click({ clickCount: 3 });
    expect(
      await page.evaluate(
        ({ sel, color }) =>
          (window as unknown as { __embed: Embed }).__embed
            .internals(document.querySelector(sel)!)
            .editor.core.run('color', { color }),
        { sel: editor, color: AUTHORED },
      ),
    ).toBe(true);
    await expect.poll(() => stored(page)).toContain(AUTHORED);

    const storedBefore = await stored(page);
    const heldBefore = await held(page, editor);
    expect(heldBefore).toContain(AUTHORED);
    const light = await drawn(page);
    expect(light).toMatchObject({ theme: 'light', run: 'rgb(192, 0, 0)' });

    // Dark, the page left light: the shell darkens, the page and the run do not change.
    await page.evaluate(() => document.querySelector('doc-editor')!.setAttribute('theme', 'dark'));
    await expect.poll(() => drawn(page).then((d) => d.theme)).toBe('dark');
    const darkLightPage = await drawn(page);
    expect(darkLightPage.page).toBe(light.page);
    expect(darkLightPage.run).toBe('rgb(192, 0, 0)');

    // Dark, the page following: the canvas goes dark and the authored run keeps its colour.
    await page.evaluate((sel) => {
      (window as unknown as { __embed: Embed }).__embed
        .internals(document.querySelector(sel)!)
        .settings.set({ pageTheme: 'follow' });
    }, editor);
    await expect.poll(() => drawn(page).then((d) => d.pageTheme)).toBe('follow');
    const darkFollow = await drawn(page);
    expect(darkFollow.page).not.toBe(light.page);
    expect(darkFollow.run).toBe('rgb(192, 0, 0)');

    // Nothing the document holds moved, on the server or in the core, in any of the three states.
    expect(await stored(page)).toBe(storedBefore);
    expect(await held(page, editor)).toBe(heldBefore);

    // Back to light: the same document, the same colour.
    await page.evaluate(() => document.querySelector('doc-editor')!.setAttribute('theme', 'light'));
    await expect.poll(() => drawn(page).then((d) => d.theme)).toBe('light');
    expect((await drawn(page)).run).toBe('rgb(192, 0, 0)');
    expect(await stored(page)).toBe(storedBefore);
    expect(await held(page, editor)).toBe(heldBefore);
  });
});
