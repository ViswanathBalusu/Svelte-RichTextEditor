// FRW-020 criterion 3: the `rules` profile of the conformance kit runs against the reference
// service, started as an operator runs it. It maps to the feature `rules`, has one scenario for
// each judged fixture, named by the fixture's identifier, and a failure names that fixture.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILES } from '../src/profiles/index.ts';
import { rulesProfileCases } from '../src/profiles/rules.ts';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { keep } from './targets/judge.ts';
import { startMock } from './targets/mock-server.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe('FRW-020: the rules profile as the kit defines it', () => {
  it('maps to the feature rules and has a scenario for each judged fixture, by identifier', () => {
    const profile = PROFILES.find((p) => p.id === 'rules')!;
    expect(profile).toBeTruthy();
    expect(profile.requires).toEqual({ kind: 'features', features: ['rules', 'fields'] });
    const { states, problems } = rulesProfileCases();
    expect(states.length).toBeGreaterThan(25);
    expect(problems.length).toBe(37);
    expect(profile.scenarios.map((s) => s.id).sort()).toEqual(
      [...states, ...problems].map((c) => `rules.${c.id}`).sort(),
    );
  });
});

describe.skipIf(skip)('FRW-020: the rules profile against the reference service', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startReference();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['rules'],
      property: { runs: 8 },
    });
    keep('reference-rules', report);
  }, 900_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('runs every scenario and reports each failing fixture by identifier', () => {
    const p = report.profiles.find((x) => x.id === 'rules');
    expect(p, 'rules profile present').toBeTruthy();
    expect(p!.scenarios.length).toBeGreaterThan(50);
    const failed = p!.scenarios
      .filter((s) => s.outcome === 'failed')
      .map((s) => `${s.id}: ${s.failure?.message ?? ''}`);
    console.log(
      'rules profile outcomes:',
      p!.scenarios.reduce<Record<string, number>>(
        (n, s) => ({ ...n, [s.outcome]: (n[s.outcome] ?? 0) + 1 }),
        {},
      ),
    );
    expect(failed).toEqual([]);
  }, 900_000);
});

describe.skipIf(skip)('FRW-020: the rules profile against the mock backend', () => {
  const run = async (ignoreFillRoles: boolean) => {
    const target = await startMock({ ignoreFillRoles });
    try {
      const report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['rules'],
        property: { runs: 8 },
      });
      return report.profiles.find((x) => x.id === 'rules')!;
    } finally {
      await target.stop();
    }
  };

  it('passes every judged fixture, as the reference service does', async () => {
    const p = await run(false);
    expect(p.scenarios.filter((s) => s.outcome === 'failed').map((s) => s.id)).toEqual([]);
    expect(p.scenarios.filter((s) => s.outcome === 'passed').length).toBeGreaterThan(60);
  }, 900_000);

  it('reports each failing fixture by its identifier when the backend gives no fill roles', async () => {
    const p = await run(true);
    const failed = p.scenarios.filter((s) => s.outcome === 'failed');
    // Every fill the fixtures say is accepted is refused by this candidate, so those fixtures fail.
    expect(failed.length).toBeGreaterThan(10);
    const fixtureIds = new Set(rulesProfileCases().states.map((c) => c.id));
    for (const s of failed) {
      const id = s.id.replace(/^rules\./, '');
      expect(fixtureIds.has(id), s.id).toBe(true);
      expect(s.failure?.message, s.id).toContain(id);
    }
    // The fixtures that expect a refusal, and the saves, do not depend on the roles and still pass.
    expect(p.scenarios.filter((s) => s.outcome === 'passed').length).toBeGreaterThan(30);
  }, 900_000);
});
