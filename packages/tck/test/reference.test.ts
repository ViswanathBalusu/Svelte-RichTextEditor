// The kit against the reference service (PRO-108; PRO-111 criterion 6), started as an operator
// runs it and reached only through its discovery URL and a service credential. A failed scenario
// must be a known defect of the service, listed below with what the specification requires and
// what the service does; the list is the kit's report of defects, and it shrinks as they are fixed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import type { KitReport } from '../src/report.ts';
import { judge, keep } from './targets/judge.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

export const REFERENCE_KNOWN: Readonly<Record<string, string>> = {
  'semantics.steps':
    'apply-020: the room refuses a step that removes one boundary of a region (P3) and the pure engine applies it (SYN-002 vs 04 §4); the same on the mock backend, reported to the authority',
  'exports.states':
    'the service runs no export job handler in process, so a job stays queued (PRO-063; 09 §9)',
  'perm-suggest.suggestion-accepted':
    'a suggestion-only user is refused with permission_denied for a suggestion mark that names the submitter as the wire shows them (03 §5; 05 §5.1): the service compares the mark with the connection surrogate (data-plane/session.ts #user, tokens.ts), not the host sub it shows in welcome',
  'perm-suggest.suggestion-accept-reject':
    'the same identity mismatch as perm-suggest.suggestion-accepted: the suggester cannot create the suggestion marks the editor then accepts or rejects (03 §5; 07 §5.2)',
};

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

describe.skipIf(skip)('the kit against the reference service', () => {
  let target: StartedTarget;
  let report: KitReport;
  beforeAll(async () => {
    target = await startReference();
    report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      fuzz: { budgetMs: 4000 },
      property: { runs: 8 },
    });
    const file = keep('reference', report);
    console.log(`reference service report: ${file}`);
  }, 900_000);
  afterAll(async () => {
    await target?.stop();
  });

  it('bootstraps from the discovery URL and the service credential alone (PRO-108 criteria 1 and 2)', () => {
    expect(report.bootstrap, target.logs().slice(-2000)).toEqual({ ok: true });
  });

  it('fails only with the known defects of the service', () => {
    const v = judge(report, REFERENCE_KNOWN);
    console.log('reference service:', v.counts);
    if (v.fixed.length)
      console.log('known defects that now pass (remove them from REFERENCE_KNOWN):', v.fixed);
    expect(v.unexpected).toEqual([]);
  });

  it('exercises in its traffic what every passing scenario declares (PRO-117)', () => {
    expect(judge(report, REFERENCE_KNOWN).unproven).toEqual([]);
  });

  // Regression: with this seed an owner's accepted `across` delete removes the open region, and the
  // kit used to throw while building the next operation on its paragraph (perm-property.test.ts).
  it('passes perm-region.property with property seed 3 (fixed-seed regression)', async () => {
    const pinned = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['perm-region'],
      scenarios: ['perm-region.property'],
      property: { runs: 8, seed: 3 },
    });
    const s = pinned.profiles
      .flatMap((p) => p.scenarios)
      .find((x) => x.id === 'perm-region.property');
    expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
  }, 120_000);
});
