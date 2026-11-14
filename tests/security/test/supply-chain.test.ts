/**
 * SEC-050 — every dependency is pinned and every change is reviewed, so a compromised or
 * incompatible package cannot enter the build unseen (10 §3.8; 04 §4; 11 §9). These are checks on
 * the repository's own configuration, so the file reads the root files directly.
 *
 * Gaps in phase 1a (noted in the story): the GitHub dependency-review action and the daily
 * advisory scan (SEC-050 criteria 2–3) are not yet wired into .github/workflows/ci.yml.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(ROOT + rel, 'utf8');

describe('SEC-050 dependencies are locked and changes are reviewed', () => {
  it('pins exact versions and refuses an unfrozen lockfile in CI', () => {
    const npmrc = read('.npmrc');
    expect(npmrc).toMatch(/save-exact\s*=\s*true/);
    expect(npmrc).toMatch(/engine-strict\s*=\s*true/);
    expect(existsSync(ROOT + 'pnpm-lock.yaml')).toBe(true);
    // Every CI install uses the frozen lockfile, so a lockfile out of step with a manifest fails.
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('pnpm install --frozen-lockfile');
  });

  it('runs no install scripts unless a package is on an allow-list', () => {
    const ws = read('pnpm-workspace.yaml');
    // onlyBuiltDependencies is the allow-list; empty means install scripts are off everywhere.
    expect(ws).toMatch(/onlyBuiltDependencies:\s*\[\s*\]/);
  });

  it('runs the licence gate in CI and denies copyleft licences', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('licence:check');
    const policy = JSON.parse(read('licences/policy.json')) as { allow: string[]; deny: string[] };
    for (const copyleft of ['GPL', 'LGPL', 'AGPL', 'SSPL'])
      expect(policy.deny, `${copyleft} is denied`).toContain(copyleft);
    // None of the denied families is also allowed.
    for (const d of policy.deny) expect(policy.allow).not.toContain(d);
  });

  it('pins the step library to an exact version, so a change forces a new engine identifier', () => {
    const authority = JSON.parse(read('packages/authority/package.json')) as {
      dependencies: Record<string, string>;
    };
    for (const lib of ['prosemirror-transform', 'prosemirror-model']) {
      const v = authority.dependencies[lib];
      expect(v, `${lib} is pinned`).toMatch(/^\d+\.\d+\.\d+$/); // exact, no range operator
    }
  });

  it('every recorded licence exception carries a reason, a decision and an expiry', () => {
    const { exceptions } = JSON.parse(read('licences/exceptions.json')) as {
      exceptions: Array<{ package: string; reason?: string; decision?: string; expires?: string }>;
    };
    for (const ex of exceptions) {
      expect(ex.reason, `${ex.package} reason`).toBeTruthy();
      expect(ex.decision, `${ex.package} decision`).toBeTruthy();
      expect(ex.expires ?? '', `${ex.package} expiry`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
