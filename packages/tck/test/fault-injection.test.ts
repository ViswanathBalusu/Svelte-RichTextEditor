// The optional fault-injection profile (PRO-126 criterion 5). A server without the test hooks skips
// the profile with a reason that names the feature, and the README states what is then unproven
// (the hash chain and the audit trail). The kit runs the same selection function (`notApplicable`)
// for every profile, so the check uses it directly; a live run needs a server with hooks, which
// does not exist yet.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { notApplicable } from '../src/runner.ts';
import { FAULT_INJECTION, TEST_HOOKS_FEATURE } from '../src/profiles/fault-injection.ts';
import { PROFILES } from '../src/profiles/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
const config = resolveConfig({ discovery: 'http://x', credential: 'c', testMode: false });
const target = (features: string[], mode: 'authority' | 'relay' = 'authority') => ({
  discovery: { mode } as never,
  features: new Set(features),
  config,
});

describe('the optional fault-injection profile (PRO-126 criterion 5)', () => {
  it('is one of the kit profiles, and maps to the test-hooks feature', () => {
    expect(PROFILES.filter((p) => p.id === 'fault-injection')).toEqual([FAULT_INJECTION]);
    expect(FAULT_INJECTION.requires).toEqual({ kind: 'features', features: [TEST_HOOKS_FEATURE] });
  });

  it('is skipped, and names the feature, for a server without the hooks', () => {
    expect(notApplicable(FAULT_INJECTION, target([]))).toMatch(/does not announce `test-hooks`/);
    expect(notApplicable(FAULT_INJECTION, target(['presence', 'regions']))).toMatch(/`test-hooks`/);
    expect(notApplicable(FAULT_INJECTION, target([], 'relay'))).toMatch(/`test-hooks`/);
  });

  it('applies to a server that announces the hooks, and then reports why it has no scenarios', () => {
    expect(notApplicable(FAULT_INJECTION, target([TEST_HOOKS_FEATURE]))).toBeNull();
    expect(FAULT_INJECTION.scenarios).toEqual([]);
    expect(FAULT_INJECTION.pending).toMatch(/PRO-126/);
  });

  it('states in the README what a server without the hooks leaves unproven', () => {
    const start = readme.indexOf('## What the kit cannot see');
    expect(start, 'the README has the section').toBeGreaterThan(-1);
    const section = readme.slice(start);
    expect(section).toMatch(/hash chain/);
    expect(section).toMatch(/audit trail/);
    expect(section).toMatch(/is reported with that profile skipped/);
    expect(readme).toContain(TEST_HOOKS_FEATURE);
  });
});
