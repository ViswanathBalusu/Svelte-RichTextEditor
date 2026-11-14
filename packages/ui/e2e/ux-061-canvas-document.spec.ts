/**
 * The theme and the page canvas do not change the stored document (UX-061, criterion 2, lane
 * V-UX-061-075). Switching the theme or the page canvas at run time leaves the document the core
 * holds, its revision and the calls the shell makes to the core unchanged, in both directions.
 * Limit: the harness's fake core holds no coloured runs, so authored colours are not present in the
 * document here, and exports are not run from the shell (no export command reads the theme).
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-061-canvas-document`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

async function shellBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const shell = document
      .getElementById('host')!
      .shadowRoot!.querySelector<HTMLElement>('.de-shell')!;
    return getComputedStyle(shell).backgroundColor;
  });
}

async function pageBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    return getComputedStyle(root.querySelector('.de-page')!).backgroundColor;
  });
}

test.describe('the theme does not change the stored document (UX-061, criterion 2)', () => {
  test('switching the theme and the page canvas leaves the document, the revision and the core calls alone', async ({
    page,
  }) => {
    const h = await open(page, { theme: 'light' });
    const documentBefore = await h.documentContent();
    const revisionBefore = await h.revision();
    const callsBefore = JSON.stringify(await h.calls());

    await h.setSettings({ theme: 'dark', pageTheme: 'follow' });
    await expect(page.locator('.de-shell')).toHaveAttribute('data-theme', 'dark');
    expect(await shellBackground(page)).toBe('rgb(22, 25, 29)');
    expect(await pageBackground(page)).toBe('rgb(27, 31, 36)');
    expect(await h.documentContent()).toBe(documentBefore);
    expect(await h.revision()).toBe(revisionBefore);
    expect(JSON.stringify(await h.calls())).toBe(callsBefore);

    await h.setSettings({ pageTheme: 'light' });
    expect(await pageBackground(page)).toBe('rgb(255, 255, 255)');
    expect(await shellBackground(page)).toBe('rgb(22, 25, 29)');
    expect(await h.documentContent()).toBe(documentBefore);
    expect(await h.revision()).toBe(revisionBefore);
    expect(JSON.stringify(await h.calls())).toBe(callsBefore);
  });
});
