// FRW-067 criterion 2 (reference service half): the `fields` profile of the conformance kit runs
// against the reference service, started as an operator runs it, and reports its scenarios. Lane
// U-FRW-055-072. The mock backend half is in mock.test.ts (lane w4, 2026-11-17).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { keep } from './targets/judge.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('FRW-067: the fields profile against the reference service', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startReference();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['fields'],
      property: { runs: 8 },
    });
    keep('reference-fields', report);
  }, 900_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('runs the fields profile and reports every scenario with an outcome', () => {
    const p = report.profiles.find((x) => x.id === 'fields');
    expect(p, 'fields profile present').toBeTruthy();
    expect(p!.scenarios.length).toBeGreaterThan(0);
    for (const s of p!.scenarios) expect(s.outcome, s.id).toBeTruthy();
  }, 900_000);

  it('passes every fields scenario the reference service announces (FRW-067 criterion 2)', () => {
    const p = report.profiles.find((x) => x.id === 'fields');
    const failed = (p?.scenarios ?? [])
      .filter((s) => s.outcome === 'failed')
      .map((s) => `${s.id}: ${s.failure?.message ?? ''}`);
    console.log(
      'fields profile outcomes:',
      (p?.scenarios ?? []).map((s) => `${s.id}=${s.outcome}`),
    );
    expect(failed).toEqual([]);
    // The scenario of I14 (lane w4, 2026-11-17) is among those that ran and passed.
    expect(p?.scenarios.find((s) => s.id === 'fields.i14.targets')?.outcome).toBe('passed');
  }, 900_000);
});
