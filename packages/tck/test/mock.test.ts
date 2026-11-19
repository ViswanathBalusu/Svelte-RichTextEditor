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
  'authz.actor.opaque':
    'the mock reads no DEP-Actor header and so does not refuse a malformed one (05 §3.2; UX-096)',
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

  it('passes the step-semantics and conversation fixtures through the server (PRO-110 criterion 5)', () => {
    const semantics = report.profiles.find((p) => p.id === 'semantics')!;
    expect(semantics.scenarios.map((s) => [s.id, s.outcome])).toEqual([
      ['semantics.conversation', 'passed'],
      ['semantics.steps', 'passed'],
    ]);
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
      'fields',
    ])
      expect(byId[id]!.outcome, id).not.toBe('skipped');
    for (const id of [
      'exports',
      'assets',
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
    // `perm-fill` runs on the mock: the test target turns the `wfr` claim of a minted token into the
    // mock's fill roles (FRW-067).
    expect(byId['perm-fill']!.outcome).toBe('passed');
  });

  it('passes every scenario of the fields profile (FRW-067 criterion 2, mock half)', () => {
    const p = report.profiles.find((x) => x.id === 'fields');
    const outcomes = Object.fromEntries((p?.scenarios ?? []).map((x) => [x.id, x.outcome]));
    expect(outcomes).toEqual({
      'fields.announce': 'passed',
      'fields.i13.keys': 'passed',
      'fields.i14.rules': 'passed',
      'fields.i14.targets': 'passed',
      'fields.i15.values': 'passed',
      'fields.p7.fill': 'passed',
      'fields.p8.server-only': 'passed',
      'fields.p9.conflict': 'passed',
      'fields.prefill': 'passed',
    });
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
