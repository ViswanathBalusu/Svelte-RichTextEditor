/**
 * The client performance harness (FND-007) and spikes S5 and S10. Run from the repository root:
 *
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts --project reference
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts e2e/s5.spec.ts
 *
 * Projects:
 * - `reference`: the reference profile of ADR 0037 (src/reference.ts): Playwright's Chromium in
 *   headless mode, 1280 × 800 at scale factor 1, CPU throttling through the DevTools protocol at
 *   the profile's rate, or at DOCEDIT_CPU_THROTTLE when set. It runs the harness, the calibration
 *   and S10's timings.
 * - `chromium`, `msedge`, `firefox`, `webkit`: the supported engines (Edge through Playwright's
 *   `msedge` channel, which needs Edge installed), for S5 and S10's cross-browser comparisons.
 *
 * Tests run one at a time (one worker), because they measure time and memory.
 */
import { defineConfig, devices } from '@playwright/test';
import { REFERENCE_PROFILE } from './src/reference.ts';

const port = Number(process.env['DOCEDIT_PERF_PORT'] ?? 4792);
const reference = {
  viewport: REFERENCE_PROFILE.viewport,
  deviceScaleFactor: REFERENCE_PROFILE.deviceScaleFactor,
};
const crossBrowser = /(s5|s9|s10)\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: './test-results/results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'reference',
      testMatch: /(harness|calibrate|s10)\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        ...reference,
        channel: 'chromium',
        headless: REFERENCE_PROFILE.headless,
      },
    },
    {
      name: 'chromium',
      testMatch: crossBrowser,
      use: { ...devices['Desktop Chrome'], ...reference, channel: 'chromium' },
    },
    {
      name: 'msedge',
      testMatch: crossBrowser,
      use: { ...devices['Desktop Edge'], ...reference, channel: 'msedge' },
    },
    {
      name: 'firefox',
      testMatch: crossBrowser,
      use: { ...devices['Desktop Firefox'], ...reference },
    },
    {
      name: 'webkit',
      testMatch: crossBrowser,
      use: { ...devices['Desktop Safari'], ...reference },
    },
  ],
  webServer: {
    command: 'node scripts/build-pages.ts && node scripts/serve.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: 'pipe',
  },
});
