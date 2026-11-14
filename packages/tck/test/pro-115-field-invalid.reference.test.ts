// The registry provocations of field_invalid against the reference service (PRO-115 criterion 3;
// lane V-PRO-103-119, round 5). The sync provocation is a fill by a user who holds `filler` and not
// `edit` (P7, 12 §4.2): the service answers field_invalid only to such a user, and the kit asserts
// the code, the surface and the retry hint. The REST provocation is a prefill of a number field
// with text, which the service refuses with field_invalid (fields.ts, 05 §5.8 surface rest).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)(
  'registry: field_invalid against the reference service (PRO-115 criterion 3)',
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
        profiles: ['registry'],
      });
    }, 600_000);

    afterAll(async () => {
      await target?.stop();
    });

    const outcome = (id: string) =>
      report.profiles.flatMap((p) => p.scenarios).find((s) => s.id === id);

    it('provokes field_invalid on the sync surface for a fill-only user', () => {
      const s = outcome('registry.field_invalid.sync');
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });

    it('provokes field_invalid on the REST surface for a prefill', () => {
      const s = outcome('registry.field_invalid.rest');
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
    });
  },
);
