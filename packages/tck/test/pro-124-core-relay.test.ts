// PRO-124: the `core-relay` profile. Selection (criterion 1) and the discovery scenario
// (criterion 4) are tested here, with a discovery document the test serves to the scenario. The
// scenarios that submit commits (criteria 2 and 3) run against a relay server in
// pro-124-core-relay.relay-target.test.ts.
import { describe, expect, it } from 'vitest';
import { KitFailure } from '../src/assert.ts';
import { resolveConfig } from '../src/config.ts';
import { CORE_RELAY } from '../src/profiles/core-relay.ts';
import { PROFILES } from '../src/profiles/index.ts';
import { notApplicable } from '../src/runner.ts';
import type { ScenarioContext } from '../src/context.ts';

const config = resolveConfig({ discovery: 'http://x', credential: 'c', testMode: false });
const target = (mode: 'authority' | 'relay', features: string[] = []) => ({
  discovery: { mode } as never,
  features: new Set(features),
  config,
});
const profile = (id: string) => {
  const p = PROFILES.find((q) => q.id === id);
  if (!p) throw new Error(`no profile ${id}`);
  return p;
};

const DISCOVERY = (over: Record<string, unknown> = {}) => ({
  versions: ['1.0'],
  ws: 'wss://relay.example.test/dep',
  rest: 'https://relay.example.test/v1',
  engines: ['pm-steps/1'],
  cdm: { min: 1, max: 1 },
  features: ['presence'],
  mode: 'relay',
  jwks_uri: 'https://relay.example.test/.well-known/jwks.json',
  ...over,
});

/** The part of the scenario context the discovery scenario reads. */
function stubContext(discovery: Record<string, unknown>): ScenarioContext {
  return {
    target: {
      discovery,
      discoveryUrl: 'https://relay.example.test/.well-known/dep',
      http: {
        request: async () => ({
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: discovery,
        }),
      },
    },
  } as unknown as ScenarioContext;
}

describe('core-relay selection (criterion 1)', () => {
  it('is the profile of a server with mode relay, and of no other', () => {
    expect(notApplicable(profile('core-relay'), target('relay'))).toBeNull();
    expect(notApplicable(profile('core-relay'), target('authority'))).toMatch(/relay/);
  });

  it('runs core-relay and not the profiles that need document semantics on a relay', () => {
    const authorityOnly = ['core', 'semantics', 'perm-doc', 'authz', 'registry', 'fuzz'];
    const relay = target('relay');
    const applicable = PROFILES.filter((p) => notApplicable(p, relay) === null).map((p) => p.id);
    expect(applicable).toContain('core-relay');
    for (const id of authorityOnly) expect(applicable, id).not.toContain(id);
  });

  it('has a scenario and is no longer listed as pending', () => {
    const p = profile('core-relay');
    expect(p.pending).toBeUndefined();
    expect(p.scenarios.map((x) => x.id)).toEqual([
      'core-relay.discovery.mode-and-features',
      'core-relay.sync.stale-base',
      'core-relay.sync.store-and-relay',
      'core-relay.sync.steps-unread',
    ]);
    expect(p.stories).toEqual(['PRO-124']);
  });
});

describe('core-relay discovery scenario (criterion 4)', () => {
  const scenario = CORE_RELAY[0]!;

  it('passes for a relay that announces none of regions, suggest-enforced, fields', async () => {
    await scenario.run(stubContext(DISCOVERY()));
    await scenario.run(stubContext(DISCOVERY({ features: ['presence', 'comments', 'leases'] })));
  });

  it('fails for each of them, and for a server that is not a relay', async () => {
    for (const f of ['regions', 'suggest-enforced', 'fields'])
      await expect(
        scenario.run(stubContext(DISCOVERY({ features: ['presence', f] }))),
      ).rejects.toBeInstanceOf(KitFailure);
    await expect(
      scenario.run(stubContext(DISCOVERY({ mode: 'authority' }))),
    ).rejects.toBeInstanceOf(KitFailure);
  });
});
