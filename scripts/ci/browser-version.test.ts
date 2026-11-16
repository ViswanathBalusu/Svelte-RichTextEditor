// The version gate of the browser jobs and the shape of the CI pipeline (FND-002).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_MINIMUMS } from '../../packages/element/scripts/vite-configs.ts';
import { PLAYWRIGHT_BROWSERS, checkVersion, minimumFor, report } from './browser-version.ts';

describe('the browser version gate (FND-002 criterion 2)', () => {
  it('reads the minimum of every Playwright browser from the build targets', () => {
    const minimums = PLAYWRIGHT_BROWSERS.map((b) => [b, minimumFor(b, BROWSER_MINIMUMS)]);
    expect(minimums).toEqual([
      ['chromium', 137],
      ['msedge', 137],
      ['firefox', 142],
      ['webkit', 17],
    ]);
  });

  it('passes a browser at or above its minimum and fails one below it', () => {
    expect(checkVersion('chromium', '137.0.7151.0', BROWSER_MINIMUMS).ok).toBe(true);
    expect(checkVersion('chromium', '136.0.7103.25', BROWSER_MINIMUMS).ok).toBe(false);
    expect(checkVersion('firefox', '141.0', BROWSER_MINIMUMS).ok).toBe(false);
    expect(checkVersion('webkit', '26.0', BROWSER_MINIMUMS).ok).toBe(true);
    expect(report(checkVersion('msedge', '120.0.1', BROWSER_MINIMUMS))).toContain('BELOW');
  });

  it('refuses a browser with no pinned minimum or an unreadable version', () => {
    expect(() => minimumFor('firefox', ['chrome137'])).toThrow(/no minimum/);
    expect(() => checkVersion('firefox', 'nightly', BROWSER_MINIMUMS)).toThrow(/cannot read/);
  });
});

describe('the CI workflow (FND-002)', () => {
  const ci = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
    'utf8',
  );
  /** The text of one job: from its key to the next key at the same indentation. */
  const job = (name: string): string => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };

  it('runs lint, type-check, the Node.js tests and the build on every pull request', () => {
    expect(ci).toMatch(/^on:\n {2}pull_request:/m);
    const check = job('check');
    for (const command of ['pnpm lint', 'pnpm typecheck', 'pnpm test ', 'pnpm build'])
      expect(check, command).toContain(`run: ${command}`);
  });

  it('runs the Playwright suites in the four browsers, behind the version gate', () => {
    const e2e = job('e2e');
    expect(e2e).toContain('browser: [chromium, msedge, firefox, webkit]');
    expect(e2e).toContain('suite: [element, ui]');
    const gate = e2e.indexOf('node scripts/ci/browser-version.ts ${{ matrix.browser }}');
    const run = e2e.indexOf('pnpm exec playwright test -c packages/${{ matrix.suite }}/');
    expect(gate).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(gate);
  });

  it('keeps the results of the browser jobs as artifacts, whatever the outcome', () => {
    const e2e = job('e2e');
    expect(e2e).toMatch(/upload-artifact@[0-9a-f]{40}/);
    expect(e2e).toContain('if: always()');
    expect(e2e).toContain('path: packages/${{ matrix.suite }}/test-results/');
  });

  it('reports the duration of every job, the browser jobs included', () => {
    const summary = job('summary');
    // Prettier breaks a long flow list after the key, so white space is allowed before the bracket.
    expect(summary).toMatch(/needs:\s*\[[^\]]*\be2e\b[^\]]*\]/);
    expect(summary).toContain('GITHUB_STEP_SUMMARY');
  });
});
