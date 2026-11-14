/**
 * The initial bundle carries the base string table only (UX-064, criterion 8; UX-070; lane
 * V-UX-061-075).
 *
 * The measurement is made on the harness build (e2e/build.ts, served by e2e/serve.ts): every script
 * the page requests from its first navigation is read in full. The base table (British English) must
 * be among them. The pseudo-locale tables (`en-XA`, `ar-XB`, src/i18n/pseudo.ts) must not be: each
 * of them uses a character that the base table never uses (U+1E7C and U+1E7D, the accented capital
 * and small V of `en-XA`; U+202E, the right-to-left override of `ar-XB`), and the test looks for
 * that character in its literal and its escaped form.
 *
 * A positive control runs in the same test: when `en-XA` is chosen, the chunk it loads does contain
 * one of those characters, so a search that finds nothing is not a search that cannot find anything.
 *
 * Run with `DOCEDIT_UI_PORT=57290 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-064-initial-bundle --project=chromium`.
 */
import { expect, open, test } from './helpers.ts';

/** The characters only the pseudo-locale tables use, literal or as a JavaScript escape. */
const PSEUDO_MARKER = /Ṽ|ṽ|‮|\\u1e7[cd]|\\u202e/i;

interface Fetched {
  url: string;
  body: string;
}

test.describe('the initial bundle (UX-064, criterion 8)', () => {
  test('carries the base table and no pseudo-locale table', async ({ page }) => {
    const fetched: Promise<Fetched>[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/assets/') || !url.pathname.endsWith('.js')) return;
      fetched.push(
        response
          .text()
          .then((body) => ({ url: url.pathname, body }))
          .catch(() => ({ url: url.pathname, body: '' })),
      );
    });

    const h = await open(page);
    const initial = await Promise.all(fetched);
    expect(initial.length).toBeGreaterThan(0);

    // The base table is in the initial bundle: a message of it is in the code the page runs.
    expect(initial.some((script) => script.body.includes('Bold'))).toBe(true);

    // No pseudo-locale table is in it, in any script requested at start.
    for (const script of initial) {
      expect(PSEUDO_MARKER.test(script.body), `${script.url} carries a pseudo-locale table`).toBe(
        false,
      );
    }

    // Positive control: choosing en-XA loads the pseudo table, and that chunk carries the marker.
    const before = fetched.length;
    await h.setLocale('en-XA');
    await expect(page.getByRole('toolbar')).toHaveAttribute('lang', 'en-XA');
    const later = await Promise.all(fetched.slice(before));
    expect(later.length).toBeGreaterThan(0);
    expect(later.some((script) => PSEUDO_MARKER.test(script.body))).toBe(true);
  });
});
