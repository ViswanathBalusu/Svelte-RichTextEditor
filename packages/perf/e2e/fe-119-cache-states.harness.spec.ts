/**
 * FE-119 criterion 4 (lane V-FE-113-128, round 4): a cold and a warm cache are both measured and
 * reported, and the report states the cache state and the network profile of each. This file does
 * not set a target and does not judge the figures: it records them, so the criterion is about the
 * report, not about the 2-second budget (criterion 1 stays open until the reference machine runs it).
 *
 * Cold: a new browser context (no HTTP cache) loads `/pages/editor.html?doc=pages-20` to `de-ready`.
 * Warm: the same page is visited again in that context, so the HTTP cache holds the assets when
 * the server lets it (start the server with `DOCEDIT_PERF_CACHE=1`; by default it sends `no-store`
 * and the warm state is the same as the cold one, which the record then states). For each
 * load the report counts the resources that came from a cache (transfer size 0) and those fetched
 * from the server, and names the network profile: no throttling, the local harness server.
 *
 * Run from the repository root (DOCEDIT_PERF_PORT picks a port in the 57070 to 57079 range):
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts --project reference fe-119-cache-states
 */
import { expect, test, type Page } from '@playwright/test';
import { browserInfo, machineInfo, writeJson } from './helpers.ts';

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
        ? `second visit in the same context: ${figures.fromCache} resources served from the cache`
        : 'second visit in the same context: no resource served from the cache (revalidated or fetched again)';
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

  const first = await page.goto('/pages/editor.html?doc=pages-20');
  const cacheControl = first?.headers()['cache-control'] ?? 'none';
  const serverCaches = !/no-store/.test(cacheControl);
  await waitForReady(page);
  const cold = await measure(page, 'cold');

  // A second visit in the same context: a new navigation, as a returning visitor makes, not a
  // reload (a reload makes the browser revalidate).
  await page.goto('about:blank');
  await page.goto('/pages/editor.html?doc=pages-20');
  await waitForReady(page);
  const warm = await measure(page, 'warm');
  await context.close();

  const profile = serverCaches
    ? `no throttling; local harness server on 127.0.0.1; server sends Cache-Control: ${cacheControl}`
    : 'no throttling; local harness server on 127.0.0.1; server sends Cache-Control: no-store';
  cold.networkProfile = profile;
  warm.networkProfile = profile;

  writeJson(serverCaches ? 'fe-119-cache-states.json' : 'fe-119-cache-states-no-store.json', {
    story: 'FE-119',
    criterion: 4,
    lane: 'w1',
    document: 'pages-20',
    browser: browserInfo(browser, 'chromium'),
    machine: machineInfo(),
    serverCacheControl: cacheControl,
    loads: [cold, warm],
  });

  // Both states are reported, each with its cache state and network profile.
  expect(cold.cacheState).toBe('cold');
  expect(warm.cacheState).toBe('warm');
  expect(cold.resources).toBeGreaterThan(0);
  expect(warm.resources).toBeGreaterThan(0);
  // A cold load starts with an empty cache, so nothing comes from it.
  expect(cold.fromCache).toBe(0);
  // With a server that allows caching (DOCEDIT_PERF_CACHE=1) the warm load must use the cache.
  // With `no-store` it cannot, and the record says so.
  if (serverCaches) expect(warm.fromCache).toBeGreaterThan(0);
  else expect(warm.fromCache).toBe(0);
});
