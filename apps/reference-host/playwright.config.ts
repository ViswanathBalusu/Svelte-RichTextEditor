/**
 * The exit check of phase 1a (11 §3; PLAN-1a) and the reference host's own checks, against the
 * demo stack. Run from the repository root:
 *
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts
 *
 * The global set-up starts the stack (scripts/stack.ps1 up) unless DOCEDIT_DEMO_REUSE=1, in which
 * case it only checks that the stack answers. One worker: the scenario's steps build on each other.
 * Chromium by default; DOCEDIT_E2E_BROWSERS=chromium,firefox,webkit runs the others too.
 */
import { defineConfig, devices } from '@playwright/test';

const port = process.env['DOCEDIT_DEMO_HOST_PORT'] ?? '56490';
const browsers = (process.env['DOCEDIT_E2E_BROWSERS'] ?? 'chromium')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const DEVICES: Record<string, (typeof devices)[string]> = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
};

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: './test-results/results.json' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: browsers.map((name) => {
    const device = DEVICES[name];
    if (!device) throw new Error(`DOCEDIT_E2E_BROWSERS: unknown browser "${name}"`);
    return { name, use: { ...device } };
  }),
});
