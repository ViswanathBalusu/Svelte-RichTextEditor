// PRO-124 criteria 2 and 3, SYN-044 criterion 5: the whole kit against a relay served over DEP
// (`test/targets/relay-server.ts`, the `Relay` of `@docedit/authority` behind discovery, the
// bootstrap routes and the real-time plane). A relay passes `core-relay` and is not tested for the
// profiles that need a document model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startRelay } from './targets/relay-server.ts';
import type { StartedTarget } from './targets/reference.ts';

const find = (report: KitReport, id: string) =>
  report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

describe('the kit against a relay over DEP (PRO-124; SYN-044 criterion 5)', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startRelay();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
    });
  }, 120_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('bootstraps from the discovery URL and the service credential alone', () => {
    expect(report.bootstrap).toEqual({ ok: true });
    expect(report.target.mode).toBe('relay');
  });

  it.each([
    'core-relay.discovery.mode-and-features',
    'core-relay.sync.stale-base',
    'core-relay.sync.store-and-relay',
    'core-relay.sync.steps-unread',
  ])('%s passes', (id) => {
    const r = find(report, id);
    expect(r?.outcome, JSON.stringify(r?.failure ?? r?.reason)).toBe('passed');
  });

  it('passes the profile and runs no other: the profiles that need a document model are skipped', () => {
    const byId = Object.fromEntries(report.profiles.map((p) => [p.id, p]));
    expect(byId['core-relay']?.outcome).toBe('passed');
    const ran = report.profiles.filter((p) => p.outcome !== 'skipped').map((p) => p.id);
    expect(ran).toEqual(['core-relay']);
    for (const id of ['core', 'semantics', 'perm-doc', 'perm-region', 'authz', 'registry', 'fuzz'])
      expect(byId[id]?.outcome, id).toBe('skipped');
  });
});

describe('the profile fails a relay that does not do what a relay does', () => {
  const runAgainst = async (opts: Parameters<typeof startRelay>[0]) => {
    const target = await startRelay(opts);
    try {
      return await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['core-relay'],
        timeoutMs: 3000,
      });
    } finally {
      await target.stop();
    }
  };

  it('fails the stale-base scenario for a relay that accepts a commit on an old base', async () => {
    const report = await runAgainst({ ignoreBase: true });
    expect(find(report, 'core-relay.sync.stale-base')?.outcome).toBe('failed');
    expect(find(report, 'core-relay.sync.store-and-relay')?.outcome).toBe('passed');
  }, 60_000);

  it('fails the store scenarios for a relay that stores nothing', async () => {
    const report = await runAgainst({ failStore: true });
    expect(find(report, 'core-relay.sync.store-and-relay')?.outcome).toBe('failed');
    expect(find(report, 'core-relay.sync.steps-unread')?.outcome).toBe('failed');
  }, 60_000);
});
