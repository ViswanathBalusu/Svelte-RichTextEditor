/**
 * End-to-end tests of the element: the embedding API and the PDF viewer (e2e/element.spec.ts,
 * e2e/pdf-viewer.spec.ts) and the matrices of spikes S1 and S2 (FE-122, FE-123, FE-125). Run from
 * the repository root with `pnpm exec playwright test -c packages/element/playwright.config.ts`.
 * The web server builds the demo (demo/build.ts) and serves it with response-header policies
 * (demo/serve.ts). Projects: Chromium, Edge (Playwright's msedge channel), Firefox and WebKit.
 */
import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
// Each run builds into its own directory under dist/runs (scripts/vite-configs.ts), so a run never
// rebuilds the files another run's server is serving (404s on assets while a rebuild runs; U-PRO-086-102).
// A run's directory is not removed when it ends, because a reused server may be serving it. Directories
// older than a day are removed when a run starts; no run lasts that long.
const runsDir = join(dirname(fileURLToPath(import.meta.url)), 'dist', 'runs');
if (existsSync(runsDir)) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of readdirSync(runsDir)) {
    const full = join(runsDir, name);
    if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
  }
}
if (!process.env['DOCEDIT_ELEMENT_DIST'])
  process.env['DOCEDIT_ELEMENT_DIST'] = `dist/runs/${process.pid}-${Date.now()}`;

export default defineConfig({
  testDir: './e2e',
  // Evidence records go to test-results/evidence (e2e/helpers.ts), which Playwright does not clean.
  // One directory per run: Playwright empties outputDir when a run starts, so runs that share it
  // delete each other's traces (ENOENT at browserContext.close) when lanes run in parallel.
  outputDir: `./test-results/playwright-${process.pid}`,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  // One retry, for browser launch failures seen with WebKit on Windows under load. A test that
  // passes only on retry is reported as flaky in the JSON report, and the spike reports count them.
  retries: 1,
  reporter: [['list'], ['json', { outputFile: './test-results/results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node demo/build.ts && node demo/serve.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: true,
    // The demo build grew with the framework hosts of the host matrix (FE-124); lanes also build at once.
    timeout: 420_000,
    stdout: 'pipe',
  },
});
