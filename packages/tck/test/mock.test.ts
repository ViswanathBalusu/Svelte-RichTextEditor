// The kit against the mock backend served over DEP (PRO-099; PRO-108; FRW-067 criterion 2): every
// profile, once with the switches off and once with the test-mode switch on, which shortens the
// timers so that the scenarios that wait for them run in seconds (PRO-109).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { judge, keep } from './targets/judge.ts';
import { startMock } from './targets/mock-server.ts';
import type { StartedTarget } from './targets/reference.ts';

/** What the mock backend does not model, with the reason; each is a gap of the mock, not of the kit. */
export const MOCK_KNOWN: Readonly<Record<string, string>> = {
  'core.rest.commits': 'the mock keeps its log inside the room and serves no commits resource',
  'perm-doc.role-change':
    'MockBackend.refresh keeps the access of the old role (05 §3.1: perm.changed)',
  'authz.read.history': 'the mock serves content at any seq to any reader: no history gate (07 §8)',
  'semantics.steps':
    'apply-020: the room refuses a step that removes one boundary of a region (P3) and the pure engine applies it (SYN-002 vs 04 §4); the same on the reference service, reported to the authority',
};

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('the kit against the mock backend over DEP', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startMock();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      fuzz: { budgetMs: 4000 },
      property: { runs: 8 },
    });
    keep('mock', report);
  }, 900_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('bootstraps from the discovery URL and the service credential alone (PRO-108 criterion 1)', () => {
    expect(report.bootstrap).toEqual({ ok: true });
    expect(report.target.features).toEqual(expect.arrayContaining(['presence', 'regions']));
  });

  it('fails only where the mock is known not to model the protocol', () => {
    const v = judge(report, MOCK_KNOWN);
    console.log('mock backend:', v.counts);
    if (v.fixed.length) console.log('known gaps of the mock that now pass:', v.fixed);
    expect(v.unexpected).toEqual([]);
  });

  it('runs the profiles of the announced features and skips the others with the reason (PRO-108 criterion 3)', () => {
    const byId = Object.fromEntries(report.profiles.map((p) => [p.id, p]));
    for (const id of [
      'core',
      'presence',
      'perm-doc',
      'perm-region',
      'authz',
      'registry',
      'fuzz',
      'semantics',
    ])
      expect(byId[id]!.outcome, id).not.toBe('skipped');
    for (const id of [
      'exports',
      'assets',
      'fields',
      'perm-fill',
      'perm-read',
      'history',
      'comments',
      'leases',
      'webhooks',
      'core-relay',
    ]) {
      expect(byId[id]!.outcome, id).toBe('skipped');
      expect(byId[id]!.reason, id).toBeTruthy();
    }
  });

  it('exercises in its traffic what every passing scenario declares (PRO-117)', () => {
    expect(judge(report, MOCK_KNOWN).unproven).toEqual([]);
  });
});

describe.skipIf(skip)(
  'the kit against the mock backend with the test-mode switch on (PRO-109)',
  () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startMock({ testMode: true });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: true,
        scenarios: [
          'core.auth.expired',
          'core.session.silence',
          'core.session.heartbeat',
          'core.discovery.no-test-switch',
          'registry.token_expired',
        ],
        profiles: ['core', 'registry'],
      });
      keep('mock-test-mode', report);
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('runs the scenarios that wait for server timers within seconds, and they pass', () => {
      const ran = report.profiles.flatMap((p) => p.scenarios);
      for (const id of [
        'core.auth.expired',
        'core.session.silence',
        'core.session.heartbeat',
        'registry.token_expired.socket',
        'registry.token_expired.rest',
      ]) {
        const s = ran.find((x) => x.id === id);
        expect(s?.outcome, `${id}: ${s?.failure?.message ?? s?.reason ?? ''}`).toBe('passed');
        expect(s!.durationMs, id).toBeLessThan(15_000);
      }
    });

    it('finds no test switch in discovery or welcome with the switch on (PRO-109 criterion 4)', () => {
      const s = report.profiles
        .flatMap((p) => p.scenarios)
        .find((x) => x.id === 'core.discovery.no-test-switch');
      expect(s?.outcome).toBe('passed');
    });
  },
);
