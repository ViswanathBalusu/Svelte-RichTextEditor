/**
 * The fault run of FE-009 criterion 7 (11 §4): three browser tabs on one real document service on
 * PostgreSQL, with dropped connections, a killed service process, a database outage and closed tabs.
 * The element's demo server serves the library build and the page `fe-009-fault-run.html`; the spec
 * starts the service and the relay itself.
 *
 * Run from the repository root, one browser at a time, with PostgreSQL and the object store of the
 * test environment up (`pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`; the service keeps
 * its checkpoints in the object store, so that a killed process finds them again):
 *   pnpm exec playwright test -c tests/fe-009-fault-run/playwright.config.ts --project=chromium
 *
 * Settings of a run, all optional:
 *   DOCEDIT_FAULT_RUN_MINUTES  how long the people type and the faults go on (default 60)
 *   DOCEDIT_FAULT_RUN_SEED     the seed of the fault schedule and the typing (default: from the clock)
 *   DOCEDIT_FAULT_RUN_OUTAGE   `postgres` (default: PostgreSQL refuses the database) or `hook` (BE-079)
 *   DOCEDIT_FAULT_RUN_DRAIN_S  how long each tab may take to send what it holds at the end (default 180)
 *   DOCEDIT_FAULT_RUN_PORT     the port of the demo server (default 57090)
 *   DOCEDIT_FAULT_RUN_REUSE    `1` uses a demo server that already runs on that port (while the
 *                              harness itself is worked on); a run for the record builds its own
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const elementDir = join(here, '..', '..', 'packages', 'element');
const port = Number(process.env['DOCEDIT_FAULT_RUN_PORT'] ?? 57090);
const minutes = Number(process.env['DOCEDIT_FAULT_RUN_MINUTES'] ?? 60);

// The element's server reads these at start-up (demo/serve.ts, scripts/vite-configs.ts).
process.env['DOCEDIT_DEMO_PORT'] = String(port);
process.env['DOCEDIT_ELEMENT_DIST'] = 'dist/runs/fe-009-fault-run';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: join(here, 'test-results'),
  // The run itself, then time to drain, compare and close.
  timeout: (minutes + 20) * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
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
    reuseExistingServer: process.env['DOCEDIT_FAULT_RUN_REUSE'] === '1',
    timeout: 300_000,
    stdout: 'pipe',
  },
});
