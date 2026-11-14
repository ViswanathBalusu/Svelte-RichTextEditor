/**
 * V-FE-113-128: browser runs against a real document service on PostgreSQL (FE-122 criterion 3).
 * The element's demo build and static server (packages/element/demo) serve the library build and
 * the page `fe-122-two-tabs.html`; the spec starts the service itself, on a database it creates.
 *
 * Run from the repository root, one browser at a time:
 *   pwsh -NoProfile -File infra/test-env.ps1 up
 *   pnpm exec playwright test -c tests/V-FE-113-128/playwright.config.ts --project=chromium
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const elementDir = join(here, '..', '..', 'packages', 'element');
const port = 57078;

// The element's server reads these at start-up (demo/serve.ts, scripts/vite-configs.ts).
process.env['DOCEDIT_DEMO_PORT'] = String(port);
process.env['DOCEDIT_ELEMENT_DIST'] = 'dist/runs/V-FE-113-128';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: join(here, 'test-results'),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node demo/build.ts && node demo/serve.ts',
    cwd: elementDir,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
  },
});
