/**
 * UX-008 criterion 5 (lane w3): the context menu opened on a misspelled word lists the proofing
 * port's suggestions, in the product's element with the real core. The backend is the mock backend
 * with a proofing port added in the page: a stand-in that flags the words it is given and answers
 * with their suggestions. No real proofing service is run (none ships; UX-043 is a spike).
 *
 * What is checked:
 * - a pointer context click on the marked word opens the editor's menu with one item per suggestion,
 *   in the port's order, and the browser's own menu is not opened (the event's default is prevented);
 * - the same with a selection elsewhere that the click does not move (the click is inside it);
 * - Shift+F10 and the Menu key with the caret in the word do the same;
 * - choosing a suggestion changes the word in the document, as an ordinary edit;
 * - a word typed after the document opened is marked after the pause and gets its suggestions too;
 * - a word the port did not flag, and an editor without a port, get no suggestion item.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts ux-008-proofing-menu
 * Browsers: see the story's evidence for the ones actually run.
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const surface = (page: Page) => page.locator(`${editor} .de-editing-surface`);
const menu = (page: Page) => page.locator(`${editor} .de-context-menu`);
const finding = (page: Page, text: string) =>
  surface(page).locator('[data-de-finding]', { hasText: text });
const suggestions = (page: Page) => menu(page).locator('[data-finding-action="apply"]');

/** The words the stand-in port flags, each with the suggestions it answers. */
const FLAGGED: Record<string, string[]> = {
  Remote: ['Remove', 'Remotely', 'Rewrote'],
  paragraf: ['paragraph', 'paragraphs'],
};

/**
 * Mounts `<doc-editor>` with the embed page's backend for Ada and a proofing port that flags
 * `flagged`. The page records each `contextmenu` event that reaches the window with whether its
 * default was prevented, in `window.__contextMenus`.
 */
async function mountWithProofing(page: Page, flagged: Record<string, string[]>): Promise<void> {
  await page.evaluate(async (words) => {
    const e = (window as unknown as { __embed: { backend(sub: string, role: string): object } })
      .__embed;
    const docId = (window as unknown as { __embed: { docId: string } }).__embed.docId;
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'one';
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
        { once: true },
      );
    });
    const port = {
      check(request: { blocks: { blockId: string; text: string }[] }) {
        const found: unknown[] = [];
        for (const b of request.blocks)
          for (const [word, answers] of Object.entries(words))
            for (let at = b.text.indexOf(word); at !== -1; at = b.text.indexOf(word, at + 1))
              found.push({
                blockId: b.blockId,
                from: at,
                to: at + word.length,
                kind: 'spelling',
                message: 'Unknown word',
                suggestions: answers,
              });
        return Promise.resolve(found);
      },
      addWord: () => Promise.resolve(),
    };
    const backend = e.backend('ada', 'editor');
    el.backend = new Proxy(backend, {
      get: (target, key) => {
        if (key === 'proofing') return port;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    el.setAttribute('doc-id', docId);
    const seen: { prevented: boolean }[] = [];
    (window as unknown as { __contextMenus: typeof seen }).__contextMenus = seen;
    // The window is the last stop of the bubbling event, so the editor's handler has run by then.
    window.addEventListener('contextmenu', (ev) => seen.push({ prevented: ev.defaultPrevented }));
    document.getElementById('mount')!.append(el);
    await ready;
  }, flagged);
  await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
}

const contextMenus = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __contextMenus: { prevented: boolean }[] }).__contextMenus,
  );

interface CoreHook {
  selection: { get(): { styleId: string | null } };
}

/** The paragraph style at the core's selection, read through the demo page's test hook. */
const selectionStyle = (page: Page) =>
  page.evaluate((sel) => {
    const w = window as unknown as {
      __embed: { internals(el: Element): { editor: { core: CoreHook } } };
    };
    return w.__embed.internals(document.querySelector(sel)!).editor.core.selection.get().styleId;
  }, editor);

/** The text the browser's selection covers inside the editor's shadow root. */
const selectedText = (page: Page) =>
  page.evaluate((sel) => {
    const root = (document.querySelector(sel) as HTMLElement).shadowRoot!;
    const selection = document.getSelection()!;
    const composed = (
      selection as unknown as {
        getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
      }
    ).getComposedRanges?.({ shadowRoots: [root] })[0];
    if (!composed) return selection.toString();
    const range = document.createRange();
    range.setStart(composed.startContainer, composed.startOffset);
    range.setEnd(composed.endContainer, composed.endOffset);
    return range.toString();
  }, editor);

test.describe('UX-008: the proofing port’s suggestions in the context menu', () => {
  test('a context click on the marked word lists the port’s suggestions, and the browser’s menu stays closed', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithProofing(page, FLAGGED);
    // The port's finding is drawn on the word, and only on it.
    await expect(finding(page, 'Remote')).toHaveText('Remote');

    await finding(page, 'Remote').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(suggestions(page)).toHaveText([
      'Change to Remove',
      'Change to Remotely',
      'Change to Rewrote',
    ]);
    // The suggestions come first, before the registry's commands.
    await expect(menu(page).locator('[data-menu-item]').first()).toHaveText('Change to Remove');
    await expect(menu(page).locator('[data-menu-item][data-command-id]').first()).toBeVisible();
    // The editor's menu replaced the browser's: the event's default was prevented.
    expect(await contextMenus(page)).toEqual([{ prevented: true }]);

    // Choosing a suggestion changes the word, and the finding goes with the old text.
    await suggestions(page).nth(1).click();
    await expect(menu(page)).toBeHidden();
    await expect.poll(() => bodyText(page)).toContain('Remotely target paragraph.');
    expect(await bodyText(page)).not.toContain('Remote target');
    await expect(finding(page, 'Remote')).toHaveCount(0);
  });

  test('a context click inside a wider selection still lists the suggestions of the word clicked', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithProofing(page, FLAGGED);
    await expect(finding(page, 'Remote')).toHaveText('Remote');
    // Select the whole paragraph from its start, so that the click lands inside the selection and
    // moves no caret, and the selection's head is at the far end, outside the word.
    await surface(page).locator('p', { hasText: 'Remote target paragraph.' }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect.poll(() => selectedText(page)).toBe('Remote target paragraph.');
    await finding(page, 'Remote').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(suggestions(page)).toHaveText([
      'Change to Remove',
      'Change to Remotely',
      'Change to Rewrote',
    ]);
    // The click kept the selection.
    expect(await selectedText(page)).toBe('Remote target paragraph.');
    await suggestions(page).first().click();
    await expect.poll(() => bodyText(page)).toContain('Remove target paragraph.');
  });

  test('the menu is built for the place that was clicked, not for where the caret was', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithProofing(page, FLAGGED);
    await expect(finding(page, 'Remote')).toHaveText('Remote');
    // The caret is in the heading, in the first paragraph of the document.
    await surface(page).getByRole('heading', { name: 'Scope' }).click();
    await expect.poll(() => selectionStyle(page)).toBe('Heading1');
    // A context click in an ordinary paragraph: by the time the menu is open the core's selection
    // is in that paragraph, so the menu's commands act there.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    expect(await selectionStyle(page)).toBe('Normal');
    await expect(menu(page).locator('[data-finding-action]')).toHaveCount(0);
  });

  test('Shift+F10 and the Menu key with the caret in the word list the suggestions', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithProofing(page, FLAGGED);
    await expect(finding(page, 'Remote')).toHaveText('Remote');
    await surface(page).locator('p', { hasText: 'Remote target paragraph.' }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    for (const key of ['Shift+F10', 'ContextMenu']) {
      await page.keyboard.press(key);
      await expect(menu(page), key).toBeVisible();
      await expect(suggestions(page), key).toHaveText([
        'Change to Remove',
        'Change to Remotely',
        'Change to Rewrote',
      ]);
      await page.keyboard.press('Escape');
      await expect(menu(page), key).toBeHidden();
    }

    // The first item has focus when the menu opens, so Enter applies the first suggestion.
    await page.keyboard.press('Shift+F10');
    await expect(suggestions(page).first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeHidden();
    await expect.poll(() => bodyText(page)).toContain('Remove target paragraph.');
  });

  test('a misspelled word typed after the document opened gets its suggestions after the pause', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithProofing(page, FLAGGED);
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' One more paragraf here');
    await expect(finding(page, 'paragraf')).toHaveText('paragraf');

    await finding(page, 'paragraf').click({ button: 'right' });
    await expect(suggestions(page)).toHaveText(['Change to paragraph', 'Change to paragraphs']);
    await suggestions(page).first().click();
    await expect.poll(() => bodyText(page)).toContain('One more paragraph here');
  });

  test('a word the port did not flag gets no suggestion item', async ({ page }) => {
    await openEmbed(page);
    await mountWithProofing(page, FLAGGED);
    await expect(finding(page, 'Remote')).toHaveText('Remote');
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('[data-finding-action]')).toHaveCount(0);
  });

  test('without a proofing port the menu has no suggestion item and nothing is marked', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    await expect(surface(page).locator('[data-de-finding]')).toHaveCount(0);
    await surface(page)
      .locator('p', { hasText: 'Remote target paragraph.' })
      .click({ button: 'right', position: { x: 20, y: 8 } });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('[data-finding-action]')).toHaveCount(0);
  });
});
