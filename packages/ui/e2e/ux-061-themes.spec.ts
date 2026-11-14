/**
 * The light and dark themes in a browser (UX-061, criteria 1 and 4). The matching built-in theme is
 * set on `.de-shell`, `auto` follows the browser's colour-scheme preference when it changes, and a
 * run-time change of the theme keeps the document mounted (no reload) and the selection. The
 * computed background of the shell is read, so the token values are seen in the cascade.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-061-themes`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

/** The theme attribute and the computed background of the shell. */
async function shellTheme(page: Page): Promise<{ theme: string | null; background: string }> {
  return page.evaluate(() => {
    const shell = document
      .getElementById('host')!
      .shadowRoot!.querySelector<HTMLElement>('.de-shell')!;
    return {
      theme: shell.getAttribute('data-theme'),
      background: getComputedStyle(shell).backgroundColor,
    };
  });
}

/** The page's computed background (the canvas) and whether the page canvas follows the theme. */
async function pageBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    return getComputedStyle(root.querySelector('.de-page')!).backgroundColor;
  });
}

// The defaults of packages/ui/src/styles/shell.css: --_de-surface for each built-in theme.
const LIGHT_SURFACE = 'rgb(255, 255, 255)';
const DARK_SURFACE = 'rgb(22, 25, 29)';

test.describe('the matching built-in theme is used (UX-061, criterion 1)', () => {
  test('light and dark set their own theme on the shell', async ({ page }) => {
    await open(page, { theme: 'light' });
    expect(await shellTheme(page)).toEqual({ theme: 'light', background: LIGHT_SURFACE });
  });

  test('dark sets the dark theme on the shell', async ({ page }) => {
    await open(page, { theme: 'dark' });
    expect(await shellTheme(page)).toEqual({ theme: 'dark', background: DARK_SURFACE });
  });

  test('auto takes the dark theme when the browser prefers dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, { theme: 'auto' });
    expect(await shellTheme(page)).toEqual({ theme: 'dark', background: DARK_SURFACE });
  });

  test('auto takes the light theme when the browser prefers light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, { theme: 'auto' });
    expect(await shellTheme(page)).toEqual({ theme: 'light', background: LIGHT_SURFACE });
  });

  test('auto follows a change of the browser preference without a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, { theme: 'auto' });
    await page.evaluate(() => {
      (window as unknown as { __ux061: string }).__ux061 = 'same document';
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.de-shell')).toHaveAttribute('data-theme', 'dark');
    expect(await shellTheme(page)).toEqual({ theme: 'dark', background: DARK_SURFACE });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('.de-shell')).toHaveAttribute('data-theme', 'light');
    const marker = await page.evaluate(() => (window as unknown as { __ux061?: string }).__ux061);
    expect(marker).toBe('same document');
  });
});

test.describe('the theme changes at run time (UX-061, criterion 4)', () => {
  test('a change of theme keeps the document and the selection', async ({ page }) => {
    const h = await open(page, { theme: 'light' });
    await h.setSelection({ empty: false, style: 'Heading 1', marks: ['bold'] });
    const before = JSON.stringify(await h.selection());
    await page.evaluate(() => {
      (window as unknown as { __ux061: string }).__ux061 = 'same document';
    });

    await h.setSettings({ theme: 'dark' });
    await expect(page.locator('.de-shell')).toHaveAttribute('data-theme', 'dark');
    expect(await shellTheme(page)).toEqual({ theme: 'dark', background: DARK_SURFACE });

    // No reload: the marker set in the page is still there, and the editor is still the same node.
    const marker = await page.evaluate(() => (window as unknown as { __ux061?: string }).__ux061);
    expect(marker).toBe('same document');
    // The selection the core holds is unchanged by the switch.
    expect(JSON.stringify(await h.selection())).toBe(before);
  });
});

test.describe('the page canvas (UX-061, criterion 2, shell side)', () => {
  test('the page stays light in the dark theme unless the host asks for the canvas to follow', async ({
    page,
  }) => {
    await open(page, { theme: 'dark' });
    expect(await pageBackground(page)).toBe('rgb(255, 255, 255)');
  });

  test('the page canvas is dark when the host asks for it to follow the dark theme', async ({
    page,
  }) => {
    await open(page, { theme: 'dark', pageTheme: 'follow' });
    expect(await pageBackground(page)).toBe('rgb(27, 31, 36)');
  });
});
