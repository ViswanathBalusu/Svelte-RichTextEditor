/**
 * Test projects (FND-001, FND-002):
 * - `node`: every unit and property test, in Node.js without a browser (02 §12).
 * - `browser`: the "universal" tests (`*.universal.test.ts`) again in real browser engines, so that
 *   the shared helpers have identical results in Node.js and every browser (FND-003, FND-005).
 *   DOCEDIT_BROWSERS picks the browsers (default `chromium,firefox,webkit`; `msedge` runs the
 *   installed Microsoft Edge through Playwright's channel). Run with `pnpm test:browsers` after
 *   `pnpm exec playwright install`.
 */
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

type Instance = {
  browser: 'chromium' | 'firefox' | 'webkit';
  name?: string;
  provider?: ReturnType<typeof playwright>;
};

const available: Record<string, Instance> = {
  chromium: { browser: 'chromium' },
  firefox: { browser: 'firefox' },
  webkit: { browser: 'webkit' },
  msedge: {
    browser: 'chromium',
    name: 'msedge',
    provider: playwright({ launchOptions: { channel: 'msedge' } }),
  },
};

const wanted = (process.env['DOCEDIT_BROWSERS'] ?? 'chromium,firefox,webkit')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
for (const b of wanted)
  if (!available[b]) throw new Error(`DOCEDIT_BROWSERS: unknown browser "${b}"`);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'services/*/src/**/*.test.ts',
            'services/*/test/**/*.test.ts',
            'tests/*/src/**/*.test.ts',
            'tests/*/test/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.browser.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'browser',
          include: ['packages/*/src/**/*.universal.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: wanted.map((b) => available[b]!),
          },
        },
      },
    ],
  },
});
