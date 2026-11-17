// PRM-057 criterion 8 (in part): the matrix scenarios of `perm-doc` and `perm-region`
// (src/profiles/perm-matrix.ts) run against the mock backend and against the reference service.
// Rows 6 and 12 need the features `assets` and `exports`, which the service announces only when an
// operator lists them; the second run lists them. Row 7 is not packaged (see the file header).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startMock } from './targets/mock-server.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

const outcomesOf = (report: KitReport) =>
  Object.fromEntries(report.profiles.flatMap((p) => p.scenarios).map((s) => [s.id, s] as const));

const ALWAYS = [
  'perm-doc.view-required',
  'perm-doc.service-routes',
  'perm-region.wrap-structure',
  'perm-region.manage-only',
];
const FEATURED = ['perm-doc.export-view', 'perm-doc.asset-upload'];

async function run(target: StartedTarget): Promise<KitReport> {
  return runKit({
    discovery: target.discovery,
    credential: target.credential,
    origin: target.origin,
    testMode: false,
    profiles: ['perm-doc', 'perm-region'],
  });
}

describe.skipIf(skip)('the matrix scenarios against the mock backend (PRM-057 criterion 8)', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startMock();
    report = await run(target);
  }, 300_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('passes the rows that need no feature', () => {
    for (const id of ALWAYS) {
      const s = outcomesOf(report)[id];
      expect(s?.outcome, `${id}: ${JSON.stringify(s?.failure)}`).toBe('passed');
    }
  });

  it('skips rows 6 and 12 because the mock announces neither assets nor exports', () => {
    for (const id of FEATURED) expect(outcomesOf(report)[id]?.outcome, id).toBe('skipped');
  });
});

describe.skipIf(skip)(
  'the matrix scenarios against the reference service (PRM-057 criterion 8)',
  () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await startReference({
        env: {
          DOCEDIT_FEATURES: 'presence,regions,suggest-enforced,read-restrictions,assets,exports',
        },
      });
      report = await run(target);
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });

    it('passes every matrix scenario, with assets and exports announced', () => {
      for (const id of [...ALWAYS, ...FEATURED]) {
        const s = outcomesOf(report)[id];
        expect(s?.outcome, `${id}: ${JSON.stringify(s?.failure ?? s?.reason)}`).toBe('passed');
      }
    });
  },
);
