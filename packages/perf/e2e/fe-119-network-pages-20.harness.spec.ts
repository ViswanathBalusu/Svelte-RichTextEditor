/**
 * FE-119 criterion 2 (lane V-FE-113-128): on the 20-page corpus document, the scripts and styles the
 * page loads before the editor reports `de-ready` must not include the PDF viewer, the math editor
 * or the panes. The list is taken from the browser's resource timing, in the reference Chromium
 * profile (no network throttling: this checks what is loaded, not how long it takes).
 *
 * Run from the repository root (DOCEDIT_PERF_PORT picks a port in the 57070 to 57079 range):
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts --project reference fe-119-network-pages-20
 *
 * The file name ends in `harness.spec.ts`, which is the reference project's test match.
 */
import { expect, test } from '@playwright/test';
import { writeJson } from './helpers.ts';

/** Chunk names of the viewer, the math editor, the read and print views and the panes. */
const NOT_CRITICAL = /pane|viewer|pdf|math|equation|print|read-?view|outline/i;

interface Loaded {
  ready: number;
  scripts: { path: string; start: number }[];
  styles: { path: string; start: number }[];
}

test('the 20-page critical path leaves the PDF viewer, the math editor and the panes out', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/pages/editor.html?doc=pages-20');
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as { __perf: { readyAt?: number; error?: string } }).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 120_000, polling: 100 },
  );
  const error = await page.evaluate(
    () => (globalThis as unknown as { __perf: { error?: string } }).__perf.error ?? null,
  );
  expect(error).toBeNull();

  const loaded: Loaded = await page.evaluate(() => {
    const readyMark = performance.getEntriesByName('harness:ready')[0]?.startTime;
    const ready =
      readyMark ?? (globalThis as unknown as { __perf: { readyAt: number } }).__perf.readyAt;
    const pick = (re: RegExp) =>
      performance
        .getEntriesByType('resource')
        .filter((e) => e.startTime < ready && re.test(new URL(e.name).pathname))
        .map((e) => ({ path: new URL(e.name).pathname, start: Math.round(e.startTime) }));
    return {
      ready: Math.round(ready),
      scripts: pick(/\.js$/),
      styles: pick(/\.css$/),
    };
  });
  await context.close();

  const scriptPaths = loaded.scripts.map((s) => s.path);
  const stylePaths = loaded.styles.map((s) => s.path);
  const violations = [...scriptPaths, ...stylePaths].filter((p) => NOT_CRITICAL.test(p));

  writeJson('fe-119-network-pages-20.json', {
    story: 'FE-119',
    criterion: 2,
    lane: 'V-FE-113-128',
    document: 'pages-20',
    browser: 'chromium (Playwright channel chromium, reference project)',
    readyAtMs: loaded.ready,
    requestedBeforeReady: loaded,
    notCriticalMatches: violations,
  });

  // The page's own editor chunk is on the critical path: the listing is not empty.
  expect(scriptPaths.some((p) => /\/editor-/.test(p))).toBe(true);
  expect(violations).toEqual([]);
});
