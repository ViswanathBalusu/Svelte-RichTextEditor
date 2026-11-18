/**
 * UX-061, criterion 2, the export half (lane w3): an export does not depend on the theme or the page
 * canvas. The same export, asked for in the light theme and in the dark theme with the page canvas
 * following, reaches the core as the same request, and the document the core holds is the same
 * before and after. The exporters themselves (packages/export-*) take only the stored document and
 * the options of 09; they read nothing of the shell. The core here is the harness's fake
 * (`test/support/fake-core.ts`); the real stored document is checked on the mounted element in
 * packages/element/e2e/ux-061-theme-document.spec.ts. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-061-export-theme`.
 */
import { expect, open, test } from './helpers.ts';

test.describe('an export is the same whatever the theme (UX-061 criterion 2)', () => {
  test('asks the core for the same export in the light and the dark theme, with the page canvas on or off', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], theme: 'light' });
    const documentBefore = await h.documentContent();
    const seen: string[] = [];
    for (const settings of [
      { theme: 'light', pageTheme: 'light' },
      { theme: 'dark', pageTheme: 'light' },
      { theme: 'dark', pageTheme: 'follow' },
    ] as const) {
      await h.setSettings(settings);
      await expect(page.locator('.de-shell')).toHaveAttribute('data-theme', settings.theme);
      await h.exec('document.export');
      const dialog = page.getByRole('dialog', { name: 'Export' });
      await dialog.getByRole('button', { name: 'Export', exact: true }).click();
      await expect.poll(async () => (await h.exportRequests()).length).toBe(seen.length + 1);
      seen.push(JSON.stringify((await h.exportRequests()).at(-1)));
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(await h.documentContent()).toBe(documentBefore);
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toContain('"target":"pdf"');
    // Nothing of the theme is in the request.
    expect(seen[0]).not.toMatch(/theme|dark|canvas/i);
  });
});
