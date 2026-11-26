// FE-125 criterion 4: the policy names the project publishes (FE-017; the S2 report, section 8)
// are compared with what the component creates (`trusted-types.ts`) and with what the S2 browser
// run required per feature (`e2e/s2-features.spec.ts`, its GUIDE table). A difference fails here.
// The browser runs themselves (criteria 1 to 3 and 5) are not part of this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_NAMES } from '../src/trusted-types.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const SPIKE = resolve(ROOT, 'docs/spikes/2026-11-06-s2-csp-trusted-types.md');
const S2_FEATURES = resolve(ROOT, 'packages/element/e2e/s2-features.spec.ts');
const HEADING = '**Policy names the project publishes (FE-017):**';

/** The names in the first column of the published table (backticked, one row each). */
function publishedNames(spike: string): string[] {
  const lines = spike.split('\n');
  const start = lines.findIndex((l) => l.startsWith(HEADING));
  expect(start, 'the published-names heading is missing from the S2 report').toBeGreaterThanOrEqual(
    0,
  );
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      if (names.length > 0) break;
      continue;
    }
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row?.[1]) names.push(row[1]);
  }
  return names;
}

/**
 * The `trusted-types` names and `style-src-attr` values the S2 run required per feature. A
 * `trusted-types` value is a list of policy names separated by white space (one feature, paste,
 * needs two), so it is split into names.
 */
function requiredByFeature(spec: string): { trustedTypes: string[]; styleSrcAttr: string[] } {
  const trustedTypes = [...spec.matchAll(/'trusted-types':\s*'([^']+)'/g)].flatMap((m) =>
    (m[1] ?? '').split(/\s+/).filter((n) => n !== ''),
  );
  const styleSrcAttr = [...spec.matchAll(/'style-src-attr':\s*"([^"]+)"/g)].map((m) => m[1] ?? '');
  return { trustedTypes, styleSrcAttr };
}

const spike = readFileSync(SPIKE, 'utf8');
const spec = readFileSync(S2_FEATURES, 'utf8');
const published = publishedNames(spike);
const required = requiredByFeature(spec);
// ProseMirror's own clipboard policy is published too; the component creates the others.
const created: string[] = Object.values(POLICY_NAMES);
const pastePolicySource = readFileSync(
  resolve(ROOT, 'packages/engine/src/view/paste-policy.ts'),
  'utf8',
);

describe('the published policy names (FE-125 criterion 4, FE-017)', () => {
  it('publish exactly the names the component creates, plus the paste policy of ProseMirror', () => {
    expect([...published].sort()).toEqual([...created, 'ProseMirrorClipboard'].sort());
  });

  it("list the engine's paste policy under the name the engine creates it with", () => {
    expect(pastePolicySource).toContain(`PASTE_POLICY_NAME = '${POLICY_NAMES.paste}'`);
  });

  it('name every trusted-types policy the S2 run required for a feature', () => {
    const missing = [...new Set(required.trustedTypes)].filter((n) => !published.includes(n));
    expect(missing).toEqual([]);
  });

  it('describe the math editor directive the S2 run required in the same words', () => {
    // The S2 report's math-editor paragraph names the directive the GUIDE table requires.
    const mathLine = spike.split('\n').find((l) => l.startsWith('**Math editor (MathLive).**'));
    expect(mathLine, 'the math editor paragraph is missing from the S2 report').toBeDefined();
    for (const directive of required.styleSrcAttr) {
      expect(mathLine).toContain(`style-src-attr ${directive}`);
    }
  });
});

// Criterion 5: a dependency update arrives as a pull request. The `e2e` job of the CI workflow runs
// on every pull request and runs the whole Playwright suite of `packages/element` in each browser,
// and no setting of that suite leaves the S2 specs out. This reads the configuration; it does not
// stand in for a hosted run.
describe('FE-125 criterion 5: CI wiring', () => {
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const config = readFileSync(resolve(ROOT, 'packages/element/playwright.config.ts'), 'utf8');

  it('runs the element Playwright suite in the e2e job on every pull request', () => {
    expect(ci).toMatch(/^on:\s*\n\s+pull_request:/m);
    const job = /^ {2}e2e:\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\n)/m.exec(ci)?.[1] ?? '';
    expect(job).toMatch(/suite: \[element, ui\]/);
    expect(job).toMatch(
      /playwright test -c packages\/\$\{\{ matrix\.suite \}\}\/playwright\.config\.ts/,
    );
    expect(job).not.toMatch(/^\s+if:.*pull_request/m);
  });

  it('keeps the S2 specs in that suite', () => {
    expect(config).toMatch(/testDir: '\.\/e2e'/);
    expect(config).not.toMatch(/testIgnore|testMatch/);
    for (const spec of ['s2-features.spec.ts', 's2-svelte-host.spec.ts']) {
      expect(
        readFileSync(resolve(ROOT, 'packages/element/e2e', spec), 'utf8').length,
      ).toBeGreaterThan(0);
    }
  });
});
