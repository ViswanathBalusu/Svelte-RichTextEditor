// `core.channel.rejected.unavailable` against the reference service (PRO-111 criterion 3). The
// service is started in test mode, so it announces `test-hooks`; the scenario makes the store
// unreachable with the database hook and expects `ch.rejected` `unavailable`. Without test mode the
// scenario is skipped with the reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';
const ID = 'core.channel.rejected.unavailable';

describe.skipIf(skip)(
  'core.channel.rejected.unavailable against the reference service (PRO-111)',
  () => {
    const find = (report: KitReport) =>
      report.profiles.flatMap((p) => p.scenarios).find((x) => x.id === ID);

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
          profiles: ['core'],
          scenarios: [ID],
        });
      }, 300_000);
      afterAll(async () => {
        await target?.stop();
      });

      it('provokes ch.rejected unavailable, and the channel opens again once the store is back', () => {
        const r = find(report);
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
          profiles: ['core'],
          scenarios: [ID],
        });
      }, 300_000);
      afterAll(async () => {
        await target?.stop();
      });

      it('is skipped, with the reason', () => {
        const r = find(report);
        expect(r?.outcome).toBe('skipped');
        expect(r?.reason ?? '').toMatch(/test-mode/);
      });
    });
  },
);
