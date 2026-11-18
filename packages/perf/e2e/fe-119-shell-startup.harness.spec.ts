/**
 * FE-119 criterion 5 (lane w1): the time the shell spends in its own initialisation (the command
 * registry, the header, the toolbar) is recorded apart from the rest of the start-up. The element
 * sets User Timing marks (`packages/element/src/startup-marks.ts`); this spec loads the 20-page
 * document in new contexts, reads the measures and writes them next to the time to `de-ready`.
 *
 * It sets no target and judges no figure: the record is the criterion. Figures are a record of one
 * run on the machine the file names, with the reference profile's CPU throttling when the project
 * sets it.
 *
 * Run from the repository root (DOCEDIT_PERF_PORT picks a port in the 57070 to 57079 range):
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts --project reference fe-119-shell-startup
 */
import { expect, test } from '@playwright/test';
import { browserInfo, machineInfo, writeJson } from './helpers.ts';

const LOADS = 5;
const NAMES = ['de:shell-registry', 'de:shell-chrome', 'de:body-view', 'de:shell-mount'] as const;

interface PerfGlobal {
  __perf: { readyAt?: number; error?: string };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (n: number): number => Math.round(n * 10) / 10;

test('the shell start-up is recorded apart from the time to ready', async ({ browser }) => {
  const loads: { readyMs: number; measures: Record<string, number> }[] = [];
  for (let i = 0; i < LOADS; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/pages/editor.html?doc=pages-20');
    await page.waitForFunction(
      () => {
        const p = (globalThis as unknown as PerfGlobal).__perf;
        return p.readyAt !== undefined || p.error !== undefined;
      },
      undefined,
      { timeout: 120_000, polling: 100 },
    );
    const got = await page.evaluate((names) => {
      const p = (globalThis as unknown as PerfGlobal).__perf;
      const measures: Record<string, number> = {};
      for (const name of names) {
        const entry = performance.getEntriesByName(name, 'measure').at(-1);
        if (entry) measures[name] = entry.duration;
      }
      return { error: p.error ?? null, readyMs: p.readyAt ?? Number.NaN, measures };
    }, NAMES);
    await context.close();
    expect(got.error).toBeNull();
    loads.push({ readyMs: got.readyMs, measures: got.measures });
  }

  for (const load of loads)
    for (const name of NAMES) expect(load.measures[name], name).toBeDefined();

  const medians: Record<string, number> = {};
  for (const name of NAMES) medians[name] = round(median(loads.map((l) => l.measures[name]!)));
  const shellOwn = round(medians['de:shell-registry']! + medians['de:shell-chrome']!);

  writeJson('fe-119-shell-startup.json', {
    story: 'FE-119',
    criterion: 5,
    lane: 'w1',
    document: 'pages-20',
    loads: LOADS,
    cacheState: 'cold (a new context for each load)',
    networkProfile: 'no throttling; local harness server on 127.0.0.1',
    browser: browserInfo(browser, 'chromium'),
    machine: machineInfo(),
    readyMsMedian: round(median(loads.map((l) => l.readyMs))),
    shellOwnInitialisationMsMedian: shellOwn,
    measuresMsMedian: medians,
    perLoad: loads.map((l) => ({
      readyMs: round(l.readyMs),
      measures: Object.fromEntries(Object.entries(l.measures).map(([k, v]) => [k, round(v)])),
    })),
  });

  // The recorded split is consistent: the shell's parts and the body view fit inside the whole.
  for (const l of loads) {
    const parts =
      l.measures['de:shell-registry']! +
      l.measures['de:shell-chrome']! +
      l.measures['de:body-view']!;
    expect(parts).toBeLessThanOrEqual(l.measures['de:shell-mount']! + 0.5);
  }
});
