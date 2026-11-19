// The quota and fault scenarios of the `registry` profile against the reference service in test mode
// (PRO-115 criterion 3): `rate_limited`, `quota_exceeded` and `unavailable` are provoked through
// `PUT /quotas` and the test hooks, and the tenant's quotas are put back afterwards. Without test mode
// the same scenarios are skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

const PROVOKED = [
  'registry.rate_limited.socket',
  'registry.rate_limited.sync',
  'registry.rate_limited.rest',
  'registry.quota_exceeded.socket',
  'registry.quota_exceeded.sync',
  'registry.quota_exceeded.rest',
  'registry.unavailable.socket',
  'registry.unavailable.rest',
  'registry.unavailable.sync',
  'registry.unavailable.channel-close',
];

describe.skipIf(skip)('quota and fault codes of the registry profile (PRO-115)', () => {
  const find = (report: KitReport, id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

  describe('in test mode', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({
        env: { DOCEDIT_TEST_MODE: 'true', DOCEDIT_ENVIRONMENT: 'test' },
      });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: true,
        profiles: ['registry'],
        scenarios: PROVOKED,
      });
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });

    it.each(PROVOKED)('%s passes', (id) => {
      const r = find(report, id);
      expect(r?.outcome, JSON.stringify(r?.failure ?? r?.reason)).toBe('passed');
    });
  });

  describe('without test mode', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({});
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['registry'],
        scenarios: PROVOKED,
      });
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('skips them all, naming the test-mode switch, and changes no quota', () => {
      for (const id of PROVOKED) {
        const r = find(report, id);
        expect(r?.outcome, id).toBe('skipped');
        expect(r?.reason ?? '', id).toMatch(/test-mode/);
      }
    });
  });
});
