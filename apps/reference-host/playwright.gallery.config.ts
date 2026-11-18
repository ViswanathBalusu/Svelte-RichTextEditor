/**
 * The template gallery's browser test (UX-100): no demo stack and no container. The spec starts the
 * real document service in memory and the host's own pages through Vite's dev server on ephemeral
 * ports. Chromium by default; DOCEDIT_E2E_BROWSERS=chromium,firefox,webkit runs the others too.
 * From the repository root:
 *
 *   pnpm exec playwright test -c apps/reference-host/playwright.gallery.config.ts
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
  testDir: './e2e-gallery',
  outputDir: `./test-results/gallery-${process.pid}`,
  timeout: 120_000,
  expect: { timeout: 15_000 },
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
