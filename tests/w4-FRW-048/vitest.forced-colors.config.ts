/**
 * Runs the forced-colours test of the signature fields (FRW-048 criterion 4) with
 * `forced-colors: active` on each Playwright context. The root `vitest.config.ts` is not changed.
 *   pnpm vitest run --config tests/w4-FRW-048/vitest.forced-colors.config.ts
 */
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: repo,
  test: {
    include: ['packages/engine/src/view/frw-048-sign-states.universal.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { forcedColors: 'active' } }),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
