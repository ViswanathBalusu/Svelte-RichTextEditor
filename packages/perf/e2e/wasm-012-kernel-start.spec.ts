/**
 * WASM-012 criterion 2: compile and instantiate time of the layout kernel (`@docedit/layout-kernel`)
 * on the reference machine, measured by the FND-007 harness (project `reference`, ADR 0037).
 *
 * Each sample is a fresh browser context, so that V8's cache of compiled modules cannot make the
 * second sample faster than the first: it is a cold compile of the file in a new renderer. The page
 * gets the file as bytes (the fetch is the network's share, measured in the library build's own
 * spec, packages/element/e2e/wasm-002-kernel-load.spec.ts) and times `WebAssembly.compile` and
 * `new WebAssembly.Instance` with `performance.now()`.
 *
 * Budget (proposed, not decided by the owner): the top of the ranges S10 measured for the whole
 * Rust prototype, 1,171,586 bytes (compile 5.6 to 8.9 ms, instantiate 0.16 to 0.41 ms; S10 report
 * section 3.3), rounded up to whole milliseconds: 9 ms to compile and 1 ms to instantiate, at the
 * median of the samples. The kernel is much smaller today, so the run is far inside it; the budget
 * is for the finished kernel. A run over a budget fails.
 *
 * Needs the kernel's build: `pnpm --filter @docedit/layout-kernel build:wasm`.
 * Result: test-results/wasm-012/<run>.json.
 * Run: `pnpm exec playwright test -c packages/perf/playwright.config.ts wasm-012 --project=reference`.
 */
import { expect, test } from '@playwright/test';
import { corpusStamp } from '@docedit/corpus';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarise } from '../src/stats.ts';
import {
  browserInfo,
  cpuLoad,
  machineInfo,
  packageDir,
  runId,
  runProfile,
  throttle,
  writeJson,
} from './helpers.ts';

const SAMPLES = Number(process.env['DOCEDIT_WASM012_SAMPLES'] ?? 15);
const BUDGET = {
  compileMs: 9,
  instantiateMs: 1,
  source: 'S10 report section 3.3: compile 5.6 to 8.9 ms, instantiate 0.16 to 0.41 ms, rounded up',
};
const file = resolve(packageDir, '../layout-kernel/dist/docedit_layout_kernel_bg.wasm');

test.skip(
  !existsSync(file),
  'the kernel is not built: pnpm --filter @docedit/layout-kernel build:wasm',
);

test('compile and instantiate of the layout kernel, cold, on the reference profile', async ({
  browser,
}) => {
  const profile = runProfile();
  const base64 = readFileSync(file).toString('base64');
  const load = cpuLoad();
  const compile: number[] = [];
  const instantiate: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.goto('/health');
    await throttle(page, profile.cpuThrottlingRate);
    const timing = await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const t0 = performance.now();
      const module = await WebAssembly.compile(bytes);
      const t1 = performance.now();
      // The module imports one function of the generated glue; the timing needs none of its work.
      const imports: Record<string, Record<string, () => void>> = {};
      for (const { module: m, name } of WebAssembly.Module.imports(module))
        (imports[m] ??= {})[name] = () => {};
      new WebAssembly.Instance(module, imports);
      const t2 = performance.now();
      return { compile: t1 - t0, instantiate: t2 - t1 };
    }, base64);
    compile.push(timing.compile);
    instantiate.push(timing.instantiate);
    await context.close();
  }
  const busy = load.stop();
  const result = {
    story: 'WASM-012',
    measuredAt: new Date().toISOString(),
    corpus: corpusStamp(),
    profile,
    machine: machineInfo(),
    onReferenceMachine: /i9-10900KF/.test(machineInfo().cpu),
    browser: browserInfo(browser, 'chromium'),
    machineBusy: busy,
    module: { file: 'docedit_layout_kernel_bg.wasm', bytes: readFileSync(file).length },
    samples: SAMPLES,
    budget: BUDGET,
    compileMs: summarise(compile),
    instantiateMs: summarise(instantiate),
  };
  writeJson(`wasm-012/${runId()}.json`, result);
  console.log(JSON.stringify({ compileMs: result.compileMs, instantiateMs: result.instantiateMs }));

  expect(result.compileMs.median).toBeLessThanOrEqual(BUDGET.compileMs);
  expect(result.instantiateMs.median).toBeLessThanOrEqual(BUDGET.instantiateMs);
});
