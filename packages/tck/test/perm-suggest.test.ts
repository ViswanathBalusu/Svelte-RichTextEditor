// The `perm-suggest` profile against the mock backend (PRO-118; 07 §5.2): the suggestion-only user is
// refused a direct change, accepted for suggestion marks, an editor accepts and rejects with the
// origins of 05 §5.3, and a property test of random suggester commits is judged by the outcome check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startMock } from './targets/mock-server.ts';
import type { StartedTarget } from './targets/reference.ts';

describe('the perm-suggest profile against the mock backend (PRO-118)', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startMock();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['perm-suggest'],
      property: { runs: 8 },
    });
  }, 600_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('runs the profile for a server that announces suggest-enforced', () => {
    const p = report.profiles.find((x) => x.id === 'perm-suggest');
    expect(p?.outcome, p?.reason ?? '').not.toBe('skipped');
  });

  it('passes every scenario: direct change refused, suggestion accepted, accept and reject, property', () => {
    const ran = report.profiles
      .flatMap((p) => p.scenarios)
      .filter((s) => s.id.startsWith('perm-suggest.'));
    expect(ran.map((s) => s.id).sort()).toEqual([
      'perm-suggest.direct-rejected',
      'perm-suggest.property',
      'perm-suggest.suggestion-accept-reject',
      'perm-suggest.suggestion-accepted',
    ]);
    for (const s of ran)
      expect(s.outcome, `${s.id}: ${s.failure?.message ?? s.reason ?? ''}`).toBe('passed');
  });
});
