/**
 * The document's direction follows the document, not the interface (UX-065, criterion 4). The
 * shell takes its direction from the interface's locale; the page takes it from the core's
 * `direction` view, which is the document's `settings.dir` (03 §4.1). Both pairings are shown: a
 * right-to-left document in a left-to-right interface, and a left-to-right document in the
 * right-to-left pseudo-locale `ar-XB`. The direction read is the computed one.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

/** The computed direction of the shell, the page and the editing surface inside it. */
async function directions(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const of = (selector: string) => getComputedStyle(root.querySelector(selector)!).direction;
    return {
      shell: of('.de-shell'),
      page: of('.de-page'),
      surface: of('.de-editing-surface'),
    };
  });
}

test.describe('the page keeps the document direction (UX-065, criterion 4)', () => {
  test('a right-to-left document in a left-to-right interface is shown right to left', async ({
    page,
  }) => {
    await open(page, { direction: 'rtl' });
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('.de-page')).toHaveAttribute('dir', 'rtl');
    expect(await directions(page)).toEqual({ shell: 'ltr', page: 'rtl', surface: 'rtl' });
  });

  test('a left-to-right document in a right-to-left interface is shown left to right', async ({
    page,
  }) => {
    const h = await open(page, { direction: 'ltr' });
    await h.setLocale('ar-XB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await h.frames(2);
    expect(await directions(page)).toEqual({ shell: 'rtl', page: 'ltr', surface: 'ltr' });
  });

  test('a right-to-left document in a right-to-left interface is right to left', async ({
    page,
  }) => {
    const h = await open(page, { direction: 'rtl' });
    await h.setLocale('ar-XB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await h.frames(2);
    expect(await directions(page)).toEqual({ shell: 'rtl', page: 'rtl', surface: 'rtl' });
  });

  test('a change of the document direction moves the page and not the shell', async ({ page }) => {
    const h = await open(page, { direction: 'ltr' });
    await h.setLocale('ar-XB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'rtl');
    await h.setDirection('rtl');
    await expect(page.locator('.de-page')).toHaveAttribute('dir', 'rtl');
    expect(await directions(page)).toEqual({ shell: 'rtl', page: 'rtl', surface: 'rtl' });
    await h.setDirection('ltr');
    await expect(page.locator('.de-page')).toHaveAttribute('dir', 'ltr');
    await h.setLocale('en-GB');
    await expect(page.locator('.de-shell')).toHaveAttribute('dir', 'ltr');
    expect(await directions(page)).toEqual({ shell: 'ltr', page: 'ltr', surface: 'ltr' });
  });
});
