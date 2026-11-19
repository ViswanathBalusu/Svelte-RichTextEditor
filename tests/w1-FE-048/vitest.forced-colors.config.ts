/**
 * Runs the forced-colours test of the comment decorations (FE-048 criterion 7; FE-019) with
 * `forced-colors: active` on each Playwright context. The root `vitest.config.ts` is not changed.
 *   pnpm vitest run --config tests/w1-FE-048/vitest.forced-colors.config.ts
 */
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: repo,
  test: {
    include: ['packages/engine/src/view/fe-048-forced-colors.universal.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { forcedColors: 'active' } }),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
