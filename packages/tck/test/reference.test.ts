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

  it('passes the step-semantics and conversation fixtures through the server (PRO-110 criterion 5)', () => {
    const semantics = report.profiles.find((p) => p.id === 'semantics')!;
    expect(semantics.scenarios.map((s) => [s.id, s.outcome])).toEqual([
      ['semantics.conversation', 'passed'],
      ['semantics.steps', 'passed'],
    ]);
  });

  // PRM-005 criterion 4: a commit on a locked and on an archived document is refused with
  // `read_only` and `drop`, and the content and its seq do not change.
  it('passes sync.read-only for locked and archived documents (PRM-005)', () => {
    const s = report.profiles
      .flatMap((p) => p.scenarios)
      .find((x) => x.id === 'core.sync.read-only');
    expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
  });

  // PRO-111 criterion 6: the `core` profile passes against the reference service, and this file runs
  // in `pnpm test`, which the CI workflow runs on every change. In-memory storage, test mode off:
  // the three scenarios that need the test-mode switch are skipped, and `core.sync.busy` is skipped
  // because the in-memory store answers the first submit before the second is read. The PostgreSQL
  // run (services/document-service/test/postgres/u-pro-103-119-core.pg.test.ts, test mode on)
  // passes all of them.
  it('passes the core profile, skipping only what needs test mode or a slow store (PRO-111 criterion 6)', () => {
    const core = report.profiles.find((p) => p.id === 'core');
    expect(core, 'the core profile ran').toBeDefined();
    const failed = core!.scenarios.filter((s) => s.outcome === 'failed').map((s) => s.id);
    expect(failed).toEqual([]);
    const skipped = core!.scenarios.filter((s) => s.outcome === 'skipped').map((s) => s.id);
    expect(skipped.sort()).toEqual([
      'core.auth.expired',
      'core.channel.rejected.unavailable',
      'core.session.silence',
      'core.sync.busy',
    ]);
    expect(core!.scenarios.filter((s) => s.id === 'core.channel.page')[0]?.outcome).toBe('passed');
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
