/**
 * FE-119 criterion 4 (lane V-FE-113-128, round 4): a cold and a warm cache are both measured and
 * reported, and the report states the cache state and the network profile of each. This file does
 * not set a target and does not judge the figures: it records them, so the criterion is about the
 * report, not about the 2-second budget (criterion 1 stays open until the reference machine runs it).
 *
 * Cold: a new browser context (no HTTP cache) loads `/pages/editor.html?doc=pages-20` to `de-ready`.
 * Warm: the same page is reloaded in that context, so the HTTP cache holds the assets. For each
 * load the report counts the resources that came from a cache (transfer size 0) and those fetched
 * from the server, and names the network profile: no throttling, the local harness server.
 *
 * Run from the repository root (DOCEDIT_PERF_PORT picks a port in the 57070 to 57079 range):
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts --project reference fe-119-cache-states
 */
import { expect, test, type Page } from '@playwright/test';
import { writeJson } from './helpers.ts';

interface Load {
  cacheState: 'cold' | 'warm';
  readyMs: number;
  resources: number;
  fromCache: number;
  fromServer: number;
  networkProfile: string;
  /** What the load observed, in words: a warm load with no cache hit is recorded as revalidated. */
  observed: string;
}

interface PerfGlobal {
  __perf: { readyAt?: number; error?: string };
}

async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as PerfGlobal).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 120_000, polling: 100 },
  );
  const error = await page.evaluate(
    () => (globalThis as unknown as PerfGlobal).__perf.error ?? null,
  );
  expect(error).toBeNull();
}

async function measure(page: Page, cacheState: 'cold' | 'warm'): Promise<Load> {
  const figures = await page.evaluate(() => {
    const readyAt = (globalThis as unknown as PerfGlobal).__perf.readyAt!;
    // Only the resources the page requested before it became ready, as fe-119-network-pages-20 does.
    const entries = performance
      .getEntriesByType('resource')
      .filter((e) => e.startTime < readyAt) as PerformanceResourceTiming[];
    const fromCache = entries.filter((e) => e.transferSize === 0).length;
    return { readyAt, resources: entries.length, fromCache };
  });
  const fromServer = figures.resources - figures.fromCache;
  let observed = 'new context, no HTTP cache entries at the start';
  if (cacheState === 'warm')
    observed =
      figures.fromCache > 0
        ? `reload in the same context: ${figures.fromCache} resources served from the cache`
        : 'reload in the same context: no resource served from the cache (revalidated or fetched again)';
  return {
    cacheState,
    readyMs: Math.round(figures.readyAt),
    resources: figures.resources,
    fromCache: figures.fromCache,
    fromServer,
    networkProfile: 'no throttling; local harness server on 127.0.0.1',
    observed,
  };
}

test('the 20-page document is measured with a cold and a warm cache, both reported with their state', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/pages/editor.html?doc=pages-20');
  await waitForReady(page);
  const cold = await measure(page, 'cold');

  await page.reload();
  await waitForReady(page);
  const warm = await measure(page, 'warm');
  await context.close();

  writeJson('fe-119-cache-states.json', {
    story: 'FE-119',
    criterion: 4,
    lane: 'V-FE-113-128',
    document: 'pages-20',
    browser: 'chromium (Playwright channel chromium, reference project)',
    machine: 'not stated: the figures are a record of this run, not a reference-machine target',
    loads: [cold, warm],
  });

  // Both states are reported, each with its cache state and network profile. The warm figure is
  // what the reload observed: the file does not require a resource to come from the cache, because
  // the harness server may send headers that make the browser revalidate every resource.
  expect(cold.cacheState).toBe('cold');
  expect(warm.cacheState).toBe('warm');
  expect(cold.resources).toBeGreaterThan(0);
  expect(warm.resources).toBeGreaterThan(0);
});
