// The `authority-service` profile against the reference authority service (PRO-125). The service runs
// as its own process, as an operator starts it; the kit is given its address only, and no discovery
// URL, so every DEP profile is skipped. A second run gives the service a bearer token, and a third
// runs the profile against an address with nothing behind it, which must fail rather than pass.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notApplicable, runKit } from '../src/runner.ts';
import { resolveConfig } from '../src/config.ts';
import type { KitReport } from '../src/report.ts';
import { AUTHORITY_SERVICE } from '../src/profiles/authority-service.ts';
import { AUTHORITY_CALLS } from '../src/authority-client.ts';
import { PROFILES } from '../src/profiles/index.ts';
import { startAuthority, type StartedAuthority } from './targets/authority.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe('the authority-service profile is selected by an address, not by DEP discovery', () => {
  const target = (authorityService?: { url: string }) => ({
    discovery: { mode: 'authority' } as never,
    features: new Set<string>(),
    config: resolveConfig({
      discovery: '',
      credential: '',
      testMode: false,
      ...(authorityService ? { authorityService } : {}),
    }),
  });

  it('is skipped, and says why, without an address', () => {
    expect(notApplicable(AUTHORITY_SERVICE, target())).toMatch(/--authority-service/);
  });

  it('applies with an address, and every other profile is skipped for a run without discovery', () => {
    const t = { ...target({ url: 'http://x' }), authorityOnly: true };
    expect(notApplicable(AUTHORITY_SERVICE, t)).toBeNull();
    for (const p of PROFILES.filter((x) => x.id !== 'authority-service'))
      expect(notApplicable(p, t), p.id).toMatch(/authority service only/);
  });

  it('is one of the kit profiles, with a scenario for each call of 05 §10', () => {
    expect(PROFILES.filter((p) => p.id === 'authority-service')).toEqual([AUTHORITY_SERVICE]);
    expect(AUTHORITY_SERVICE.pending).toBeUndefined();
    expect(AUTHORITY_SERVICE.scenarios.length).toBeGreaterThan(0);
    expect(AUTHORITY_CALLS).toEqual([
      'open',
      'applyCommit',
      'materialise',
      'mapRanges',
      'restoreSteps',
      'diff',
      'attribution',
      'migrate',
      'evaluateRules',
    ]);
  });
});

describe.skipIf(skip)('the reference authority service passes the profile (PRO-125)', () => {
  let service: StartedAuthority;
  let report: KitReport;
  let restarts = 0;

  beforeAll(async () => {
    service = await startAuthority();
    report = await runKit({
      discovery: '',
      credential: '',
      testMode: false,
      profiles: ['authority-service'],
      authorityService: {
        url: service.url,
        restart: async () => {
          restarts++;
          return service.restart();
        },
      },
    });
  }, 600_000);

  afterAll(async () => {
    await service?.stop();
  });

  const scenarios = () => report.profiles.flatMap((p) => p.scenarios);
  const outcome = (id: string) => scenarios().find((x) => x.id === id);

  it('runs with no discovery URL and passes', () => {
    expect(report.bootstrap.ok).toBe(true);
    const failed = scenarios().filter((x) => x.outcome === 'failed');
    expect(
      failed.map(
        (f) => `${f.id}: ${f.failure?.message} ${f.failure?.expected} ${f.failure?.received}`,
      ),
      service.logs(),
    ).toEqual([]);
    expect(report.profiles).toHaveLength(1);
    expect(report.profiles[0]!.outcome).toBe('passed');
    expect(report.ok).toBe(true);
  });

  it.each([
    ['authority-service.capabilities', 'the calls it implements and its probes'],
    ['authority-service.open-materialise', 'open and materialise (criterion 1)'],
    ['authority-service.apply-commit', 'applyCommit (criterion 1)'],
    ['authority-service.history-calls', 'restoreSteps, diff and attribution (criterion 1)'],
    ['authority-service.evaluate-rules', 'evaluateRules, with the rules fixtures (criterion 2)'],
    ['authority-service.migrate', 'migrate, refused unless enabled (criterion 1)'],
    ['authority-service.canonical-hash', 'the canonical-hash fixtures (criterion 2)'],
    ['authority-service.steps', 'the step-semantics fixtures (criterion 2)'],
    ['authority-service.restart', 'a repeated call after a restart (criterion 3)'],
  ])('%s passes: %s', (id) => {
    expect(outcome(id)?.outcome).toBe('passed');
  });

  it('restarted the service, and the calls repeated gave the same results (criterion 3)', () => {
    expect(restarts).toBe(1);
  });

  it('runs every fixture through the service and says how many', () => {
    expect(outcome('authority-service.steps')?.notes.join(' ')).toMatch(
      /apply cases of pm-steps\/1/,
    );
    expect(outcome('authority-service.evaluate-rules')?.notes.join(' ')).toMatch(/68 rules cases/);
    expect(outcome('authority-service.canonical-hash')?.notes.join(' ')).toMatch(/9 canonical/);
  });

  it('runs mapRanges through the route of PRO-105, and it passes (criterion 1)', () => {
    expect(outcome('authority-service.map-ranges')?.outcome).toBe('passed');
  });

  it('covers every call of 05 §10: the service announces the eight it must, and migrate is checked either way', () => {
    const caps = scenarios().find((x) => x.id === 'authority-service.capabilities');
    expect(caps?.outcome).toBe('passed');
    for (const call of AUTHORITY_CALLS.filter((c) => c !== 'migrate'))
      expect(caps?.notes.join(' '), call).toMatch(new RegExp(`\\b${call}\\b`));
    expect(outcome('authority-service.migrate')?.outcome).toBe('passed');
  });

  it('skips the token scenario for a service without a token', () => {
    expect(outcome('authority-service.access')?.outcome).toBe('skipped');
  });
});

describe.skipIf(skip)('a service with a bearer token (PRO-125)', () => {
  let service: StartedAuthority;
  beforeAll(async () => {
    service = await startAuthority({ env: { DOCEDIT_AUTHORITY_TOKEN: 'tck-test-token' } });
  }, 60_000);
  afterAll(async () => {
    await service?.stop();
  });

  it('passes with the token, and the access scenario checks that a call without it is refused', async () => {
    const report = await runKit({
      discovery: '',
      credential: '',
      testMode: false,
      profiles: ['authority-service'],
      scenarios: ['authority-service.access', 'authority-service.capabilities'],
      authorityService: { url: service.url, token: 'tck-test-token' },
    });
    expect(report.ok, JSON.stringify(report.profiles[0]?.scenarios.map((s) => s.failure))).toBe(
      true,
    );
    expect(report.totals).toMatchObject({ passed: 2, failed: 0 });
  });

  it('fails when the kit has no token', async () => {
    const report = await runKit({
      discovery: '',
      credential: '',
      testMode: false,
      profiles: ['authority-service'],
      scenarios: ['authority-service.capabilities'],
      authorityService: { url: service.url },
    });
    expect(report.ok).toBe(false);
  });
});

describe('a service that is not there fails the profile, it does not pass it (PRO-125)', () => {
  it('reports a failed run for an address that nothing answers', async () => {
    const report = await runKit({
      discovery: '',
      credential: '',
      testMode: false,
      profiles: ['authority-service'],
      scenarios: ['authority-service.capabilities'],
      authorityService: { url: 'http://127.0.0.1:1' },
    });
    expect(report.ok).toBe(false);
    expect(report.totals.failed).toBe(1);
  });

  it('refuses a run with neither a discovery URL nor an authority service', async () => {
    const report = await runKit({ discovery: '', credential: '', testMode: false });
    expect(report.bootstrap.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});
