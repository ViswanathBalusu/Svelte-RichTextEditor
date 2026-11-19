/**
 * The cross-browser run of the layout kernel (WASM-011): the same WebAssembly file, started in
 * Chromium, Edge, Firefox and WebKit, must give the advances and the lines that Node.js recorded in
 * `golden/reference.json`. It needs no server: the spec serves the build and the fonts through the
 * browser's own request routing. Run from the repository root with
 *
 *   pnpm --filter @docedit/layout-kernel build:wasm
 *   pnpm exec playwright test -c packages/layout-kernel/playwright.config.ts
 *
 * `DOCEDIT_BROWSERS=msedge` (or any project name, comma separated) limits the run to those projects.
 */
import { defineConfig, devices } from '@playwright/test';

const all = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];
const wanted = (process.env['DOCEDIT_BROWSERS'] ?? '').split(',').filter(Boolean);

export default defineConfig({
  testDir: './e2e',
  outputDir: `./test-results/playwright-${process.pid}`,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  retries: 1,
  reporter: [['list']],
  projects: wanted.length ? all.filter((p) => wanted.includes(p.name)) : all,
});
