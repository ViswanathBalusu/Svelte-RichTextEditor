// The licence gate for Cargo crates (FND-011 criterion 2).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CargoMetadata,
  everyOptionAllowed,
  findCargoManifests,
  normaliseCargoLicence,
  productionCrates,
  readCargoMetadata,
} from './cargo-licences.ts';
import { type Policy, evaluate } from './licence-policy.ts';

const ROOT = join(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(join(ROOT, 'licences/policy.json'), 'utf8')) as Policy;

const pkg = (name: string, license: string | null, source: string | null = 'registry+x') => ({
  id: `${name}@1.0.0`,
  name,
  version: '1.0.0',
  license,
  manifest_path: `/c/${name}/Cargo.toml`,
  source,
});
const dep = (to: string, ...kinds: Array<string | null>) => ({
  pkg: `${to}@1.0.0`,
  dep_kinds: kinds.map((kind) => ({ kind })),
});

describe('crates of the Rust module', () => {
  const meta: CargoMetadata = {
    packages: [
      pkg('kernel', 'Apache-2.0', null),
      pkg('shaper', 'MIT'),
      pkg('macro', 'MIT OR Apache-2.0'),
      pkg('tester', 'GPL-3.0-only'),
      pkg('builder', 'AGPL-3.0-only'),
      pkg('orphan', 'GPL-3.0-only'),
    ],
    workspace_members: ['kernel@1.0.0'],
    resolve: {
      nodes: [
        {
          id: 'kernel@1.0.0',
          deps: [dep('shaper', null), dep('tester', 'dev'), dep('builder', 'build')],
        },
        { id: 'shaper@1.0.0', deps: [dep('macro', null, 'build')] },
        { id: 'macro@1.0.0', deps: [] },
        { id: 'tester@1.0.0', deps: [] },
        { id: 'builder@1.0.0', deps: [] },
        { id: 'orphan@1.0.0', deps: [] },
      ],
    },
  };

  it('are the normal dependencies, reached through normal dependencies, without the members', () => {
    expect(productionCrates(meta).map((c) => c.name)).toEqual(['macro', 'shaper']);
  });

  it('leave out development and build dependencies and crates nothing reaches', () => {
    const names = productionCrates(meta).map((c) => c.name);
    expect(names).not.toContain('tester');
    expect(names).not.toContain('builder');
    expect(names).not.toContain('orphan');
  });

  it('are judged by the policy of the npm packages, with the old A/B form read as A OR B', () => {
    expect(normaliseCargoLicence('MIT/Apache-2.0')).toBe('MIT OR Apache-2.0');
    expect(normaliseCargoLicence(null)).toBeNull();
    expect(evaluate('MIT OR Apache-2.0', policy).ok).toBe(true);
    const bad = evaluate('GPL-3.0-only', policy);
    expect(bad.ok).toBe(false);
    expect(evaluate(undefined, policy).ok).toBe(false);
  });

  it('need no recorded decision for a dual licence of allowed options only', () => {
    expect(everyOptionAllowed('Zlib OR Apache-2.0 OR MIT', policy)).toBe(true);
    expect(everyOptionAllowed('(MIT OR Apache-2.0) AND Unicode-3.0', policy)).toBe(true);
    // One option that is not allowed means a choice with a consequence.
    expect(everyOptionAllowed('MIT OR GPL-3.0-only', policy)).toBe(false);
    expect(evaluate('MIT OR GPL-3.0-only', policy)).toEqual({ ok: true, dual: true });
    expect(everyOptionAllowed('not a licence ((', policy)).toBe(false);
  });
});

describe('the crates of this repository', () => {
  const manifests = findCargoManifests(ROOT);
  const cargo = spawnSync(process.env['CARGO'] || 'cargo', ['--version'], { encoding: 'utf8' });
  const reason = cargo.status === 0 ? null : 'cargo is not available';

  it('are found where a Cargo.lock sits beside a Cargo.toml', () => {
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) expect(m).toMatch(/Cargo\.toml$/);
  });

  it.skipIf(reason !== null)(
    `all have an allowed licence in the policy${reason ? ` (skipped: ${reason})` : ''}`,
    () => {
      for (const manifest of manifests) {
        const crates = productionCrates(readCargoMetadata(manifest));
        expect(crates.length).toBeGreaterThan(0);
        for (const c of crates) {
          const v = evaluate(c.licence ?? undefined, policy);
          expect(v.ok, `${c.name}@${c.version}: ${c.licence}`).toBe(true);
          if (v.ok && v.dual) expect(everyOptionAllowed(c.licence!, policy)).toBe(true);
        }
      }
    },
    120_000,
  );
});
