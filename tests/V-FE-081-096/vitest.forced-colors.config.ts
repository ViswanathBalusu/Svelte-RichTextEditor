/**
 * Runs the forced-colours painter test (FE-096 criterion 5) with `forced-colors: active` on each
 * Playwright context. Lane V-FE-081-096 only; the root `vitest.config.ts` is not changed.
 *   pnpm vitest run --config tests/V-FE-081-096/vitest.forced-colors.config.ts
 */
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: repo,
  test: {
    include: ['packages/painter/src/selection-forced.universal.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { forcedColors: 'active' } }),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
