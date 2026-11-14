/**
 * Browser tests of the shell (UX-003, UX-004, UX-006, UX-014, UX-016, UX-025, UX-026, UX-064), with
 * axe checks. Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts`. The web server builds the
 * harness (e2e/build.ts) and serves it under the strict policy of spike S2 (e2e/serve.ts).
 * Projects: Chromium, Firefox and WebKit; `DOCEDIT_BROWSERS=msedge` adds Edge.
 */
import { defineConfig, devices, type Project } from '@playwright/test';

// 4791 is the element's demo and 4792 the performance harness (packages/perf).
const port = Number(process.env['DOCEDIT_UI_PORT'] ?? 4796);

const available: Record<string, Project> = {
  chromium: { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  firefox: { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  webkit: { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  msedge: { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
};

const wanted = (process.env['DOCEDIT_BROWSERS'] ?? 'chromium,firefox,webkit')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  outputDir: './test-results/playwright',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  // One retry, for browser launch failures; a test that passes only on retry is reported as flaky.
  retries: 1,
  reporter: [['list'], ['json', { outputFile: './test-results/results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: wanted.map((b) => {
    const project = available[b];
    if (!project) throw new Error(`DOCEDIT_BROWSERS: unknown browser "${b}"`);
    return project;
  }),
  webServer: {
    command: 'node e2e/build.ts && node e2e/serve.ts',
    url: `http://127.0.0.1:${port}/health`,
    // Never take over a server of another package by accident: reuse only when asked to.
    reuseExistingServer: process.env['DOCEDIT_UI_REUSE'] === '1',
    timeout: 120_000,
    stdout: 'pipe',
  },
});
