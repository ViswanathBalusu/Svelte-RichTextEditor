// The authorisation profile against the reference service (PRO-115 criteria 1 and 2; lane
// V-PRO-103-119, round 3). The service is started as an operator runs it (startReference), in
// memory, and the kit reaches it only through its discovery URL and the service credential.
//
// Two runs. The first uses the features the service announces by default: the service-credential
// rows (criterion 2) and the rows that need no feature must pass both ways; export is skipped
// because the reference service announces `exports` only with a compile worker. The second runs
// with `comments`, `history` and `leases` in DOCEDIT_FEATURES, the features of the routes of rows
// 4, 5, 8, 9 and 11. The service serves those routes but does not announce the features by
// default, so the kit skips those rows there. The second run is evidence for the owner's decision
// on the announcement; it is not a claim that the default service announces them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

const outcomesOf = (report: KitReport) =>
  Object.fromEntries(
    report.profiles
      .flatMap((p) => p.scenarios)
      .map((s) => [s.id, { outcome: s.outcome, failure: s.failure }] as const),
  );

describe.skipIf(skip)(
  'authz against the reference service, default features (PRO-115 criteria 1 and 2)',
  () => {
    let target: StartedTarget;
    let report: KitReport;

    beforeAll(async () => {
      target = await startReference();
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['authz'],
      });
    }, 600_000);

    afterAll(async () => {
      await target?.stop();
    });

    it('refuses every user token on every route of row 13 and allows the service credential (criterion 2)', () => {
      const s = outcomesOf(report)['authz.service'];
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });

    it('calls rows 1, 2 and 10 with and without the capability (criterion 1)', () => {
      for (const id of ['read.head', 'read.history', 'manage']) {
        const s = outcomesOf(report)[`authz.${id}`];
        expect(s?.outcome, `${id}: ${JSON.stringify(s?.failure)}`).toBe('passed');
      }
    });

    it('skips row 12 only because the target does not announce exports', () => {
      const s = outcomesOf(report)['authz.export'];
      expect(s?.outcome).toBe('skipped');
    });

    it('passes the unmatrixed routes that follow D65', () => {
      const s = outcomesOf(report)['authz.unmatrixed'];
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });
  },
);

describe.skipIf(skip)(
  'authz against the reference service with comments, history and leases announced (PRO-115 criterion 1)',
  () => {
    let target: StartedTarget;
    let report: KitReport;

    beforeAll(async () => {
      target = await startReference({
        env: {
          DOCEDIT_FEATURES:
            'presence,regions,suggest-enforced,read-restrictions,comments,history,leases',
        },
      });
      report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['authz'],
      });
    }, 600_000);

    afterAll(async () => {
      await target?.stop();
    });

    it('calls rows 4, 5 and 11 with and without the capability', () => {
      for (const id of ['thread.create', 'thread.update', 'lease.acquire']) {
        const s = outcomesOf(report)[`authz.${id}`];
        expect(s?.outcome, `${id}: ${JSON.stringify(s?.failure)}`).toBe('passed');
      }
    });

    it('calls row 8 with and without the capability', () => {
      const s = outcomesOf(report)['authz.version.create'];
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });

    // The defect HIS-018 recorded here (a region restore refused to an editor with `manage`) is fixed:
    // the restore route now checks the row version.create before it reads region.
    it('row 9: a viewer is refused and an editor may restore a region (HIS-018)', () => {
      const s = outcomesOf(report)['authz.restore.region'];
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });
  },
);
