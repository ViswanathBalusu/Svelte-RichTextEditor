/**
 * The library build carries the base string table only, at start (UX-064, criterion 8; UX-070;
 * lane V-UX-061-075).
 *
 * The page `pages/lib.html` loads the distributable (`/lib/doc-editor.js`) by URL, as a host does.
 * Every script under `/lib/` that the page requests from the import on is read in full. The base
 * table must be among them, and no pseudo-locale table (src/i18n/pseudo.ts in the shell) may be:
 * each pseudo table uses a character the base table never uses (U+1E7C and U+1E7D for `en-XA`,
 * U+202E for `ar-XB`), searched for in its literal and its escaped form (the text of a pattern
 * that names them does not count).
 *
 * The positive control: after the element's `locale` attribute is set to `en-XA`, a chunk loaded
 * for it carries one of those characters.
 *
 * Run with `DOCEDIT_DEMO_PORT=57291 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-064-initial-bundle.spec.ts --project=chromium`.
 */
import { expect, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';

// A literal character, or a single-escaped one. A double-escaped one (a backslash before the
// backslash) is the text of a pattern, as in the engine's check for bidirectional controls in
// identifiers (U+202A to U+202E), and is not a pseudo-locale table.
const PSEUDO_MARKER = /Ṽ|ṽ|‮|(?<!\\)\\u(?:1e7[cd]|202e)/i;

interface Fetched {
  url: string;
  body: string;
}

test.describe('the library build at start (UX-064, criterion 8)', () => {
  test('carries the base table and no pseudo-locale table', async ({ page }) => {
    const fetched: Promise<Fetched>[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/lib/') || !url.pathname.endsWith('.js')) return;
      fetched.push(
        response
          .text()
          .then((body) => ({ url: url.pathname, body }))
          .catch(() => ({ url: url.pathname, body: '' })),
      );
    });

    await openLib(page);
    await page.evaluate(() =>
      (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib.load(),
    );
    await page.evaluate(async () => {
      const lib = (window as unknown as { __lib: { docId: string; backend(sub: string): unknown } })
        .__lib;
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'bundle';
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      el.backend = lib.backend('ada');
      el.setAttribute('doc-id', lib.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    });
    await expect(page.locator('doc-editor[data-test="bundle"] .de-editing-surface')).toBeVisible();

    const initial = await Promise.all(fetched);
    expect(initial.some((s) => s.url.endsWith('/doc-editor.js'))).toBe(true);
    expect(initial.some((script) => script.body.includes('Bold'))).toBe(true);
    for (const script of initial) {
      expect(PSEUDO_MARKER.test(script.body), `${script.url} carries a pseudo-locale table`).toBe(
        false,
      );
    }

    // Positive control: the en-XA table is a separate chunk, and it carries the marker.
    const before = fetched.length;
    await page.evaluate(() =>
      document
        .querySelector<HTMLElement>('doc-editor[data-test="bundle"]')!
        .setAttribute('locale', 'en-XA'),
    );
    await expect
      .poll(async () => {
        const later = await Promise.all(fetched.slice(before));
        return later.some((s) => PSEUDO_MARKER.test(s.body));
      })
      .toBe(true);
  });
});
