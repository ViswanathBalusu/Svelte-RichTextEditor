// Profile selection for a relay without an authority service (PRO-101 criterion 4). A relay that
// announces none of the content, history or export features must not have the kit run the profiles
// that need content reads, restore, comparison or export; each is reported as skipped with the reason.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { PROFILES } from '../src/profiles/index.ts';
import { notApplicable } from '../src/runner.ts';

const config = resolveConfig({ discovery: 'http://x', credential: 'c', testMode: false });
const relay = (features: string[]) => ({
  discovery: { mode: 'relay' } as never,
  features: new Set(features),
  config,
});
const byId = (id: string) => {
  const p = PROFILES.find((q) => q.id === id);
  if (!p) throw new Error(`no profile ${id}`);
  return p;
};

// Profiles that need the authority service (05 §2; the relay is not in authority mode).
const AUTHORITY_ONLY = ['core', 'semantics', 'perm-doc', 'authz', 'registry', 'fuzz'];
// Profiles that need a feature a relay without an authority service does not announce: exports
// (export), history (restore, comparison, attribution), assets and read restrictions (content reads).
const FEATURE_ONLY: Array<[string, string]> = [
  ['exports', 'exports'],
  ['history', 'history'],
  ['assets', 'assets'],
  ['perm-read', 'read-restrictions'],
];
// Features a relay may announce without an authority service (none of them needs the authority).
const RELAY_SAFE = ['presence', 'comments', 'webhooks', 'leases'] as const;

describe('relay without an authority service (PRO-101 criterion 4)', () => {
  it('does not run the authority-mode profiles, and says why', () => {
    for (const id of AUTHORITY_ONLY) {
      expect(notApplicable(byId(id), relay([])), id).toMatch(/authority mode/);
    }
  });

  it('does not run the content, restore, comparison or export profiles without their features', () => {
    for (const [id, feature] of FEATURE_ONLY) {
      expect(notApplicable(byId(id), relay([])), id).toMatch(
        new RegExp(`does not announce \`${feature}\``),
      );
    }
  });

  it('keeps those profiles skipped whatever relay-safe features it announces', () => {
    fc.assert(
      fc.property(fc.subarray([...RELAY_SAFE]), (announced) => {
        for (const id of AUTHORITY_ONLY) {
          expect(notApplicable(byId(id), relay(announced)), id).not.toBeNull();
        }
        for (const [id, feature] of FEATURE_ONLY) {
          expect(notApplicable(byId(id), relay(announced)), id).toMatch(
            new RegExp(`does not announce \`${feature}\``),
          );
        }
      }),
      { numRuns: 50 },
    );
  });

  it('runs a feature profile only when the relay announces its feature', () => {
    // Selection is per feature: announcing one feature selects only the profile that needs it.
    expect(notApplicable(byId('exports'), relay(['exports']))).toBeNull();
    expect(notApplicable(byId('history'), relay(['exports']))).toMatch(/`history`/);
  });
});
