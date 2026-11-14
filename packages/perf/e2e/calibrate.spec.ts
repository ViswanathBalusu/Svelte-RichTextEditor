/**
 * Calibration of the CPU throttling profile (ADR 0037). Runs the calibration workload
 * (pages/calibrate.html) at several DevTools CPU throttling rates and records its time per
 * iteration at each, so that:
 *
 * - on the reference machine, the response of the workload to the rate is known (time at rate r
 *   divided by time at rate 1);
 * - on another machine, the rate that reproduces the reference machine's time is found: the spec
 *   compares with baseline/calibration.json and reports the rate to use.
 *
 * Opt-in, because it takes minutes: DOCEDIT_CALIBRATE=1. Rates: DOCEDIT_CALIBRATE_RATES
 * (default 1,1.5,2,3,4). Result: test-results/calibration/<run>.json.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusStamp } from '@docedit/corpus';
import { summarise } from '../src/stats.ts';
import {
  browserInfo,
  cpuLoad,
  machineInfo,
  packageDir,
  runId,
  throttle,
  writeJson,
} from './helpers.ts';

interface Iteration {
  totalMs: number;
  buildMs: number;
  jsonMs: number;
  domMs: number;
  paragraphs: number;
}

interface CalibrationReference {
  rate: number;
  medianMs: number;
  run: string;
}

test.skip(process.env['DOCEDIT_CALIBRATE'] !== '1', 'calibration is opt-in: DOCEDIT_CALIBRATE=1');

test('calibration workload at several CPU throttling rates', async ({ browser }) => {
  const rates = (process.env['DOCEDIT_CALIBRATE_RATES'] ?? '1,1.5,2,3,4').split(',').map(Number);
  const iterations = Number(process.env['DOCEDIT_CALIBRATE_ITERATIONS'] ?? 7);
  const id = runId();
  const results: {
    rate: number;
    samplesMs: number[];
    median: number;
    spread: number;
    machineBusy: number;
    breakdown: Iteration[];
  }[] = [];
  for (const rate of rates) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/pages/calibrate.html');
    await page.waitForFunction(
      () => (globalThis as { __calibrate?: { ready: boolean } }).__calibrate?.ready === true,
    );
    await throttle(page, rate);
    const load = cpuLoad();
    const its = await page.evaluate(
      (n) =>
        (
          globalThis as unknown as { __calibrate: { run(n: number): Promise<Iteration[]> } }
        ).__calibrate.run(n),
      iterations,
    );
    const totals = its.map((i) => i.totalMs);
    const s = summarise(totals);
    const busy = load.stop().busyShare;
    results.push({
      rate,
      samplesMs: totals,
      median: s.median,
      spread: (s.max - s.min) / s.median,
      machineBusy: busy,
      breakdown: its,
    });
    console.log(
      `[calibrate] rate ${rate}: median ${s.median.toFixed(1)} ms (min ${s.min.toFixed(1)}, max ${s.max.toFixed(1)})`,
    );
    await context.close();
  }
  const base = results.find((r) => r.rate === 1);
  const response = results.map((r) => ({
    rate: r.rate,
    slowdown: base ? r.median / base.median : null,
  }));
  const refFile = join(packageDir, 'baseline/calibration.json');
  let advice: {
    referenceMedianMs: number;
    referenceRate: number;
    rateForThisMachine: number;
  } | null = null;
  if (existsSync(refFile) && base) {
    const ref = JSON.parse(readFileSync(refFile, 'utf8')) as CalibrationReference;
    // If time grows in proportion to the rate (`response` shows how far it does), the rate that
    // reproduces the reference time is that time divided by this machine's time at rate 1. The
    // spec reports it; a second run at that rate confirms it.
    advice = {
      referenceMedianMs: ref.medianMs,
      referenceRate: ref.rate,
      rateForThisMachine: ref.medianMs / base.median,
    };
  }
  const file = writeJson(`calibration/${id}.json`, {
    schema: 'docedit-perf-calibration/1',
    runId: id,
    machine: machineInfo(),
    browser: browserInfo(browser, 'chromium'),
    corpus: corpusStamp(),
    workload:
      'pages/calibrate.html (build pages-100 with the corpus generator, JSON round trip, DOM render and 300 relayouts)',
    iterationsPerRate: iterations,
    results,
    response,
    advice,
  });
  console.log(`[calibrate] wrote ${file}`);
  expect(results.length).toBe(rates.length);
});
