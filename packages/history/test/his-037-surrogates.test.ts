// HIS-037 criterion 4 (lane V-HIS-033-046): the audit segment holds the surrogate identifiers of the
// log and never a host `sub`. The host's `sub` values live only in the tenant's mapping (BE-013),
// which is not an input of the bundle or the segment. This test builds a log whose actors are
// surrogates, keeps the host subs apart as the service does, and checks the serialised segment.
import { describe, expect, it } from 'vitest';
import { auditSegment } from '../src/audit-segment.ts';
import { bundleOf } from './bundle.ts';
import { LogBuilder, typeAt } from './fixtures.ts';

const HOST_SUBS = ['alice@example.test', 'bob.host-sub-0042', 'carol-123456'];
const SURROGATES = ['sur_7f3a9c01', 'sur_b2e4d610', 'sur_c08e5f72'];

describe('the audit segment holds surrogates only (HIS-037 criterion 4)', () => {
  it('serialises the surrogates of its records and no host sub, over any range', async () => {
    const b = new LogBuilder();
    for (let i = 0; i < 6; i++)
      b.add((d) => typeAt(d, 'pIntro0000000001', 0, `text ${i} `), {
        user: SURROGATES[i % SURROGATES.length]!,
      });
    const bundle = await bundleOf(b.log, [{ seq: 0, doc: b.docs[0]! }]);
    // The mapping from subs to surrogates is held by the service and is not passed in.
    const mapping = new Map(HOST_SUBS.map((sub, i) => [sub, SURROGATES[i]!] as const));
    expect(mapping.size).toBe(3);

    const r = auditSegment(bundle, { fromSeq: 1, toSeq: 6 });
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    const json = JSON.stringify(r.segment);
    for (const sub of HOST_SUBS) expect(json).not.toContain(sub);
    for (const s of SURROGATES) expect(json).toContain(s);
  });
});
