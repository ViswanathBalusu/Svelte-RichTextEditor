/**
 * Reports the version of the browser a CI job is about to test, and fails when it is older than the
 * minimum the product supports (02 §12; FND-002 criterion 2). The minimums are the build targets of
 * the component (`BROWSER_MINIMUMS` in packages/element/scripts/vite-configs.ts), so one list pins
 * both what the build emits and what the suites may run on.
 *
 *   node scripts/ci/browser-version.ts chromium|msedge|firefox|webkit
 *
 * Playwright's WebKit reports the Safari version it corresponds to.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYWRIGHT_BROWSERS = ['chromium', 'msedge', 'firefox', 'webkit'] as const;
export type PlaywrightBrowser = (typeof PLAYWRIGHT_BROWSERS)[number];

/** The build-target name of each Playwright browser (`chrome137`, `edge137`, ...). */
const TARGET_NAME: Record<PlaywrightBrowser, string> = {
  chromium: 'chrome',
  msedge: 'edge',
  firefox: 'firefox',
  webkit: 'safari',
};

/** The minimum major version of a browser, read from build targets such as `chrome137`. */
export function minimumFor(browser: PlaywrightBrowser, targets: readonly string[]): number {
  const name = TARGET_NAME[browser];
  const target = targets.find((t) => t.startsWith(name) && /^\d+$/.test(t.slice(name.length)));
  if (!target) throw new Error(`no minimum version is pinned for ${browser} (${name})`);
  return Number(target.slice(name.length));
}

export type VersionCheck = {
  browser: PlaywrightBrowser;
  version: string;
  major: number;
  minimum: number;
  ok: boolean;
};

export function checkVersion(
  browser: PlaywrightBrowser,
  version: string,
  targets: readonly string[],
): VersionCheck {
  const major = Number(/^(\d+)/.exec(version.trim())?.[1] ?? Number.NaN);
  if (!Number.isInteger(major))
    throw new Error(`${browser}: cannot read a version from "${version}"`);
  const minimum = minimumFor(browser, targets);
  return { browser, version: version.trim(), major, minimum, ok: major >= minimum };
}

export function report(check: VersionCheck): string {
  const verdict = check.ok ? 'at or above' : 'BELOW';
  return `${check.browser} ${check.version}: ${verdict} the supported minimum ${check.minimum}`;
}

async function main(argv: string[]): Promise<number> {
  const browser = argv[0] as PlaywrightBrowser | undefined;
  if (!browser || !PLAYWRIGHT_BROWSERS.includes(browser)) {
    console.error(`usage: browser-version.ts ${PLAYWRIGHT_BROWSERS.join('|')}`);
    return 2;
  }
  const { BROWSER_MINIMUMS } = await import('../../packages/element/scripts/vite-configs.ts');
  const playwright = await import('playwright');
  const launched =
    browser === 'msedge'
      ? await playwright.chromium.launch({ channel: 'msedge' })
      : await playwright[browser].launch();
  let check: VersionCheck;
  try {
    check = checkVersion(browser, launched.version(), BROWSER_MINIMUMS);
  } finally {
    await launched.close();
  }
  console.log(report(check));
  return check.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
