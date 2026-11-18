// PRM-065 criterion 3 and PRM-034 criterion 4: the split and merge scenarios of `perm-region`
// (src/profiles/perm-structure.ts) run against the mock backend and the reference service.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startMock } from './targets/mock-server.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';
const IDS = ['perm-region.split-merge', 'perm-region.split-restricted'];

async function run(target: StartedTarget): Promise<KitReport> {
  return runKit({
    discovery: target.discovery,
    credential: target.credential,
    origin: target.origin,
    testMode: false,
    profiles: ['perm-region'],
    scenarios: IDS,
  });
}

const outcomes = (report: KitReport) =>
  Object.fromEntries(report.profiles.flatMap((p) => p.scenarios).map((s) => [s.id, s] as const));

for (const [name, start] of [
  ['the mock backend', startMock],
  ['the reference service', startReference],
] as const) {
  describe.skipIf(skip)(`split and merge scenarios against ${name} (PRM-065)`, () => {
    let target: StartedTarget;
    let report: KitReport;
    beforeAll(async () => {
      target = await start();
      report = await run(target);
    }, 300_000);
    afterAll(async () => {
      await target?.stop();
    });
    it.each(IDS)('passes %s', (id) => {
      const s = outcomes(report)[id];
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });
  });
}
