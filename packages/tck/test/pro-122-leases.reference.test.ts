// The `leases` profile against the reference service (PRO-122). The service runs as its own process
// with `leases` announced (DOCEDIT_FEATURES, as the PRO-115 run does) and, for the expiry, with test
// mode on, which shortens the region lease and publishes the value at `GET /_test/timers` (PRO-109).
// Without test mode the expiry scenario is skipped with the reason; without the feature every
// scenario is skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';
const FEATURES = 'presence,regions,suggest-enforced,read-restrictions,leases';

describe.skipIf(skip)('leases profile against the reference service (PRO-122)', () => {
  const find = (report: KitReport, id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

  describe('in test mode', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({
        env: {
          DOCEDIT_FEATURES: FEATURES,
          DOCEDIT_TEST_MODE: 'true',
          DOCEDIT_ENVIRONMENT: 'test',
        },
      });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: true,
        profiles: ['leases'],
      });
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });

    it.each([
      'leases.acquire-needs-edit',
      'leases.break-needs-manage',
      'leases.exclusive',
      'leases.expiry',
      'leases.break-ends',
    ])('%s passes', (id) => {
      const r = find(report, id);
      expect(r?.outcome, JSON.stringify(r?.failure ?? r?.reason)).toBe('passed');
    });
  });

  describe('without test mode', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({ env: { DOCEDIT_FEATURES: FEATURES } });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['leases'],
      });
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('runs the scenarios that need no timer and skips the expiry with the reason', () => {
      expect(find(report, 'leases.exclusive')?.outcome).toBe('passed');
      expect(find(report, 'leases.break-ends')?.outcome).toBe('passed');
      const expiry = find(report, 'leases.expiry');
      expect(expiry?.outcome).toBe('skipped');
      expect(expiry?.reason ?? '').toMatch(/test-mode/);
    });
  });

  describe('without the feature', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({ env: { DOCEDIT_FEATURES: 'presence,regions' } });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['leases'],
      });
    }, 120_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('skips the profile, naming the feature', () => {
      const p = report.profiles.find((x) => x.id === 'leases');
      expect(p?.outcome).toBe('skipped');
      expect(p?.reason ?? '').toMatch(/leases/);
    });
  });
});
