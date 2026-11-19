// The `webhooks` profile against the reference service (PRO-121). The service runs as its own
// process with webhook delivery on, a retry schedule, and test mode on with the loopback address of
// the kit's receiver in its test-mode allow-list (ADR 0316 proposal 2; DOCEDIT_TEST_WEBHOOK_ALLOW).
// Without test mode the same address is refused, so the allow-list cannot be used by accident, and
// a service without webhook delivery makes the profile skip with the reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

const WEBHOOK_ENV = {
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '5000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
  DOCEDIT_WEBHOOK_RETRY_BASE_MS: '300',
  DOCEDIT_WEBHOOK_RETRY_FACTOR: '2',
};

const IDS = [
  'webhooks.body',
  'webhooks.signature',
  'webhooks.rotation',
  'webhooks.retry',
  'webhooks.debounce',
];

describe.skipIf(skip)('webhooks profile against the reference service (PRO-121)', () => {
  const find = (report: KitReport, id: string) =>
    report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === id);

  describe('with delivery on, in test mode, the receiver allowed', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({
        env: {
          ...WEBHOOK_ENV,
          DOCEDIT_TEST_MODE: 'true',
          DOCEDIT_ENVIRONMENT: 'test',
          DOCEDIT_TEST_WEBHOOK_ALLOW: '127.0.0.1',
        },
      });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: true,
        profiles: ['webhooks'],
        receiver: { host: '127.0.0.1' },
        scenarioTimeoutMs: 120_000,
      });
    }, 400_000);
    afterAll(async () => {
      await target?.stop();
    });

    it.each(IDS)('%s passes', (id) => {
      const r = find(report, id);
      expect(r?.outcome, JSON.stringify(r?.failure ?? r?.reason)).toBe('passed');
    });
  });

  describe('with delivery on, the receiver not allowed', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({ env: { ...WEBHOOK_ENV } });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['webhooks'],
        scenarios: ['webhooks.body'],
        receiver: { host: '127.0.0.1' },
        timeoutMs: 3_000,
      });
    }, 120_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('delivers nothing to a loopback receiver, so the scenario fails and no request arrived', () => {
      const r = find(report, 'webhooks.body');
      expect(r?.outcome).toBe('failed');
      expect(r?.failure?.message ?? '').toMatch(/reached the receiver/);
      expect(r?.failure?.received ?? '').toMatch(/0 requests/);
    });
  });

  describe('without webhook delivery', () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({});
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['webhooks'],
      });
    }, 120_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('skips every scenario with the reason', () => {
      for (const id of IDS) {
        const r = find(report, id);
        expect(r?.outcome, id).toBe('skipped');
        expect(r?.reason ?? '', id).toMatch(/webhook/);
      }
    });
  });
});
