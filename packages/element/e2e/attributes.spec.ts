/**
 * The embedding attributes that choose how the editor opens and looks (05 §8.1; PRO-077 and
 * PRO-079). The embed page (`pages/embed.html`) with its in-memory backend, as mode.spec.ts does.
 *
 * Checked here: `mode="edit"` for an editor (PRO-077 criterion 1); `theme` of `light`, `dark` and
 * `auto` at mount and while open, with `auto` following the colour scheme (PRO-079 criterion 3);
 * `toolbar` of `full`, `compact` and `none` at mount and while open (PRO-079 criterion 4). The
 * view, the locale strings and the page layout of `view="web"` are not checked here (PRO-079 notes).
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;
const shell = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-shell`);
const surface = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-editing-surface`);

interface EmbedProbe {
  internals(el: Element): { editor: { core: { mode: { get(): unknown } } } | null };
}

function coreMode(page: Page, name = 'one') {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedProbe }).__embed;
    const el = document.querySelector(sel)!;
    return e.internals(el).editor!.core.mode.get();
  }, editor(name));
}

function setAttr(page: Page, attr: string, value: string, name = 'one') {
  return page.evaluate(([sel, a, v]) => document.querySelector(sel)!.setAttribute(a, v), [
    editor(name),
    attr,
    value,
  ] as const);
}

test.describe('PRO-077 the mode attribute for an editor', () => {
  test('mode="edit" for a user whose access allows editing: editing is available', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', role: 'editor', mode: 'edit' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    expect(await coreMode(page)).toEqual({ requested: 'edit', effective: 'edit' });
  });
});

test.describe('PRO-078 the review mode for a viewer', () => {
  test('mode="review" for a user with view only: the editor is read-only, the server still decides', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'vic', role: 'viewer', mode: 'review' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');
    expect(await coreMode(page)).toEqual({ requested: 'review', effective: 'view' });
  });
});

test.describe('PRO-079 the theme attribute', () => {
  test('theme="dark" at mount, and a change while open, sets the shell theme without a reload', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { theme: 'dark' } });
    await expect(shell(page)).toHaveAttribute('data-theme', 'dark');
    await setAttr(page, 'theme', 'light');
    await expect(shell(page)).toHaveAttribute('data-theme', 'light');
    await setAttr(page, 'theme', 'dark');
    await expect(shell(page)).toHaveAttribute('data-theme', 'dark');
  });

  test('theme="auto" follows the operating system colour scheme, also while open', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { theme: 'auto' } });
    await expect(shell(page)).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(shell(page)).toHaveAttribute('data-theme', 'light');
  });

  test('theme="light" stays light whatever the colour scheme is', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { theme: 'light' } });
    await expect(shell(page)).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('PRO-079 the locale attribute', () => {
  test('a locale change while open: the toolbar label comes from the new locale, with no remount', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { locale: 'en-GB' } });
    const label = () =>
      page.evaluate((sel) => {
        const root = document.querySelector(sel)!.shadowRoot!;
        const bar = root.querySelector('.de-toolbar')!;
        const w = window as unknown as Record<string, unknown>;
        if (w['__bar'] === undefined) w['__bar'] = bar;
        return {
          label: bar.getAttribute('aria-label'),
          sameBar: w['__bar'] === bar,
        };
      }, editor());
    const before = await label();
    expect(before.label).toBeTruthy();

    await setAttr(page, 'locale', 'ar-XB');
    // The locale table loads on demand; the label changes once it is in.
    await expect.poll(async () => (await label()).label).not.toBe(before.label);
    expect(await label()).toMatchObject({ sameBar: true });
  });
});

test.describe('PRO-079 the toolbar attribute', () => {
  test('toolbar="full" shows the full toolbar; "none" shows no toolbar; "compact" the panel', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { toolbar: 'full' } });
    await expect(page.locator(`${editor()} .de-toolbar-full`)).toBeVisible();

    await setAttr(page, 'toolbar', 'none');
    await expect(page.locator(`${editor()} .de-toolbar-full`)).toHaveCount(0);
    await expect(page.locator(`${editor()} .de-toolbar`)).toHaveCount(0);

    await setAttr(page, 'toolbar', 'compact');
    await expect(page.locator(`${editor()} .de-toolbar`)).toBeVisible();
    await expect(page.locator(`${editor()} .de-toolbar-full`)).toHaveCount(0);
  });

  test('toolbar="none" at mount: no toolbar, and the editing surface still takes input', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { toolbar: 'none' } });
    await expect(page.locator(`${editor()} .de-toolbar`)).toHaveCount(0);
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
  });
});
