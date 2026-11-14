// The `history` profile against the reference service (PRO-119; lane V-PRO-103-119, round 5). The
// service is started with `history` in DOCEDIT_FEATURES, as an operator announces it. Only the
// read-marker scenario exists yet: the comparison, attribution and history routes and the dry-run
// restore are not served (see the Notes of PRO-119), so the profile has one scenario.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('history profile against the reference service (PRO-119)', () => {
  let target: StartedTarget;
  let report: KitReport;

  beforeAll(async () => {
    target = await startReference({
      env: { DOCEDIT_FEATURES: 'presence,regions,suggest-enforced,read-restrictions,history' },
    });
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['history'],
    });
  }, 600_000);

  afterAll(async () => {
    await target?.stop();
  });

  it('runs the profile for a server that announces history', () => {
    const p = report.profiles.find((x) => x.id === 'history');
    expect(p?.outcome, p?.reason ?? '').not.toBe('skipped');
  });

  it('keeps a read marker where it is when it is moved backwards (criterion 4)', () => {
    const s = report.profiles
      .flatMap((p) => p.scenarios)
      .find((x) => x.id === 'history.read-marker.forward-only');
    expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
  });
});
