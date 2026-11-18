/**
 * The administration console's browser tests (UX-089): no demo stack and no web server of
 * their own (the spec builds and serves the console on an ephemeral port). Chromium by default;
 * DOCEDIT_E2E_BROWSERS=chromium,firefox,webkit runs the others too. From the repository root:
 *
 *   pnpm exec playwright test -c apps/reference-host/playwright.admin.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

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
  testDir: './e2e-admin',
  outputDir: `./test-results/admin-${process.pid}`,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: browsers.map((name) => {
    const device = DEVICES[name];
    if (!device) throw new Error(`DOCEDIT_E2E_BROWSERS: unknown browser "${name}"`);
    return { name, use: { ...device } };
  }),
});
