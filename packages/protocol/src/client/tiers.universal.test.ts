// The three backend tiers and what each may announce (05 §9; PRO-101 criteria 1 to 3). Universal:
// Node.js and browsers.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEP1_WIRE } from '../definition/wire.ts';
import type { Discovery } from '../generated/types.ts';
import {
  AUTHORITY_SERVICE_CALLS,
  AUTHORITY_SERVICE_NEEDS,
  PROJECTION_CALL,
  featuresSupportedBy,
  tierProblems,
} from './tiers.ts';

const ALL = DEP1_WIRE.features.map((f) => f.name);
const FORBIDDEN = DEP1_WIRE.features.filter((f) => f.relayForbidden).map((f) => f.name);
const announce = (features: string[], mode: Discovery['mode'] = 'authority') => ({
  features: features as Discovery['features'],
  mode,
});

describe('the table of what a feature needs', () => {
  it('names only registered features and calls of 05 §10 (or the undefined projection call)', () => {
    for (const [feature, calls] of Object.entries(AUTHORITY_SERVICE_NEEDS)) {
      expect(ALL, feature).toContain(feature);
      for (const c of calls) {
        expect([...AUTHORITY_SERVICE_CALLS, PROJECTION_CALL], `${feature} needs ${c}`).toContain(c);
      }
    }
  });

  it('leaves the relay-forbidden features to need `applyCommit`', () => {
    for (const f of FORBIDDEN) expect(AUTHORITY_SERVICE_NEEDS[f], f).toContain('applyCommit');
  });
});

describe('a native backend (criterion 1)', () => {
  it('may announce every feature of the definition', () => {
    expect(tierProblems({ tier: 'native', discovery: announce(ALL) })).toEqual([]);
  });

  it('may announce any subset of them, in either mode, with no authority service', () => {
    fc.assert(
      fc.property(fc.subarray(ALL), fc.constantFrom('authority', 'relay'), (features, mode) => {
        expect(tierProblems({ tier: 'native', discovery: announce(features, mode) })).toEqual([]);
      }),
    );
  });
});

describe('a sidecar-backed backend (criterion 2)', () => {
  it('needs an authority service', () => {
    expect(tierProblems({ tier: 'sidecar', discovery: announce([]) })).toMatchObject([
      { code: 'sidecar_without_service' },
    ]);
    expect(
      tierProblems({ tier: 'sidecar', discovery: announce([]), authorityServiceCalls: [] }),
    ).toMatchObject([{ code: 'sidecar_without_service' }]);
  });

  it('announces what the authority service supports and nothing else', () => {
    fc.assert(
      fc.property(
        fc.subarray([...AUTHORITY_SERVICE_CALLS], { minLength: 1 }),
        fc.subarray(ALL),
        (calls, features) => {
          const supported = new Set(featuresSupportedBy(calls));
          const problems = tierProblems({
            tier: 'sidecar',
            discovery: announce(features),
            authorityServiceCalls: calls,
          });
          const outside = features.filter((f) => !supported.has(f)).sort();
          expect(problems.map((p) => p.feature).sort()).toEqual(outside);
          for (const p of problems) expect(p.code).toBe('needs_authority_service');
        },
      ),
    );
  });

  it('can announce every feature except the one that needs the undefined projection call', () => {
    const all = featuresSupportedBy(AUTHORITY_SERVICE_CALLS);
    expect(ALL.filter((f) => !all.includes(f))).toEqual(['read-restrictions']);
  });
});

describe('a relay (criterion 3, the announcing half)', () => {
  it('announces mode `relay`', () => {
    expect(tierProblems({ tier: 'relay', discovery: announce([], 'authority') })).toMatchObject([
      { code: 'relay_mode' },
    ]);
    expect(tierProblems({ tier: 'relay', discovery: announce(['presence'], 'relay') })).toEqual([]);
  });

  it('never announces regions, suggest-enforced or fields, with or without the authority service', () => {
    expect(FORBIDDEN.sort()).toEqual(['fields', 'regions', 'suggest-enforced']);
    for (const f of FORBIDDEN) {
      for (const calls of [undefined, [...AUTHORITY_SERVICE_CALLS]]) {
        const problems = tierProblems({
          tier: 'relay',
          discovery: announce([f], 'relay'),
          ...(calls ? { authorityServiceCalls: calls } : {}),
        });
        expect(problems, f).toMatchObject([{ code: 'relay_forbidden', feature: f }]);
      }
    }
  });

  it('announces features that need document semantics only with an authority service for them', () => {
    const needing = Object.keys(AUTHORITY_SERVICE_NEEDS).filter((f) => !FORBIDDEN.includes(f));
    expect(needing).toEqual(
      expect.arrayContaining(['history', 'exports', 'assets', 'rules', 'read-restrictions']),
    );
    for (const f of needing) {
      expect(tierProblems({ tier: 'relay', discovery: announce([f], 'relay') }), f).toMatchObject([
        { code: 'needs_authority_service', feature: f },
      ]);
    }
    expect(
      tierProblems({
        tier: 'relay',
        discovery: announce(['history', 'exports'], 'relay'),
        authorityServiceCalls: ['open', 'materialise', 'restoreSteps', 'diff', 'attribution'],
      }),
    ).toEqual([]);
  });

  it('may announce the relay-safe features on its own', () => {
    const safe = ['presence', 'comments', 'leases'];
    expect(tierProblems({ tier: 'relay', discovery: announce(safe, 'relay') })).toEqual([]);
  });
});
