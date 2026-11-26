// Spike S3 (SPK-016) and the production suite in process (SYN-047): random concurrent commits of
// all seven step types, reconnects, failed and unknown writes, lost grant notifications and room
// failovers, some of which fence the old room. Every client applies the log in the log's order
// (G1), every acknowledged commit is stored (G2), all clients converge (G3), nothing is stored twice
// (G4), every channel's messages arrive in sequence order (G5), attribution is the server's (G6),
// and no stored commit changed a scope outside its submitter's writable set at the revision it was
// checked against (G7; 07 §5.1; PRM-017).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALLOWED_STEP_TYPES } from '../src/steps.ts';
import type { UserName } from './fixtures.ts';
import { CAST, opArbitrary } from './harness/ops.ts';
import { type Op, Simulation } from './harness/sim.ts';

const op = opArbitrary();
const RUNS = Number(process.env['S3_RUNS'] ?? 300);

/**
 * Regression fixtures (PRM-017): a failing run prints its seed, fast-check's shrunk counterexample
 * and the same sequence as JSON (`regression: {...}`). Paste that JSON here to replay it first on
 * every run, before the random schedules.
 */
const REGRESSIONS: Array<{ users: UserName[]; ops: Op[] }> = [];

function runOnce(
  ops: Op[],
  users: UserName[],
  malicious: UserName[],
): { failures: string[]; sim: Simulation } {
  const sim = new Simulation({ users, malicious });
  sim.run(ops);
  return { failures: sim.check(), sim };
}

const add = (into: Map<string, number>, from: ReadonlyMap<string, number>) => {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
};

describe('S3: correctness of the authority', () => {
  it('G1 to G7: total order, durability before visibility, convergence, idempotent submission, gap-free delivery, server attribution and no stale authorisation, with no change outside the writable set', () => {
    const totals = {
      commits: 0,
      steps: 0,
      rejected: 0,
      faults: 0,
      crashes: 0,
      fenced: 0,
      grants: 0,
      lost: 0,
      recovered: 0,
      ordered: 0,
      approvedChecked: 0,
    };
    const codes = new Map<string, number>();
    const submitted = new Map<string, number>();
    const stored = new Map<string, number>();
    const property = fc.property(
      fc.array(op, { minLength: 60, maxLength: 240 }),
      fc.subarray(CAST, { minLength: 2 }),
      (ops, users) => {
        const { failures, sim } = runOnce(ops, users, ['mallory']);
        totals.ordered += sim.orderChecked;
        totals.approvedChecked += sim.stats.approvedChecked;
        totals.commits += sim.storage.log.filter((c) => c.kind === 'steps').length;
        totals.steps += sim.storage.log.reduce((a, c) => a + c.steps.length, 0);
        totals.faults += sim.stats.faults;
        totals.crashes += sim.stats.crashes;
        totals.fenced += sim.stats.fenced;
        totals.grants += sim.stats.grantChanges;
        totals.lost += sim.stats.lostNotifications;
        for (const [k, v] of sim.stats.rejected) {
          codes.set(k, (codes.get(k) ?? 0) + v);
          totals.rejected += v;
        }
        add(submitted, sim.stats.submittedTypes);
        add(stored, sim.storedTypes());
        for (const c of sim.clients) totals.recovered += c.recovered;
        // fast-check shrinks a failing schedule; the message of the shrunk one ends with the
        // sequence as JSON, ready to be saved in REGRESSIONS.
        expect(
          failures,
          `${failures.join('\n')}\nregression: ${JSON.stringify({ users, ops })}`,
        ).toEqual([]);
      },
    );
    fc.assert(property, { numRuns: RUNS, examples: REGRESSIONS.map((r) => [r.ops, r.users]) });
    // Removing a mark from a tab needs a stored tab mark first, a chain that
    // 15 local runs of 300 schedules (2026-11-26) stored 2 to 9 times, so a seed now and then (hosted
    // CI run 45864375181) stores it never.
    // Rather than a fixed seed, which would hide a real regression, further rounds run until every
    // step type has been stored (at most ten rounds; a type still missing then fails below).
    const unstored = () => ALLOWED_STEP_TYPES.filter((t) => (stored.get(t) ?? 0) === 0);
    for (let round = 0; round < 10 && unstored().length > 0; round++)
      fc.assert(property, { numRuns: RUNS });
    console.log(
      `S3 totals over ${RUNS} runs: ${JSON.stringify(totals)}; rejections by code: ${JSON.stringify(Object.fromEntries(codes))}; step types submitted: ${JSON.stringify(Object.fromEntries(submitted))}; stored: ${JSON.stringify(Object.fromEntries(stored))}`,
    );
    // The run is not vacuous: commits were stored and rejected, and faults, failovers, fenced
    // writes and lost notifications happened. Thresholds scale with the number of runs and sit at
    // about two fifths of the means of the runs of 2026-11-06 (2.4 step commits, 4.8 steps, 2.6
    // rejections and 22 ordered messages per schedule over 300 schedules), so that a short run of
    // 100 schedules is several standard deviations clear of them.
    expect(totals.commits).toBeGreaterThan(RUNS);
    expect(totals.steps).toBeGreaterThan(RUNS * 2);
    expect(totals.rejected).toBeGreaterThan(RUNS / 5);
    expect(totals.faults).toBeGreaterThan(RUNS / 10);
    expect(totals.crashes).toBeGreaterThan(RUNS / 20);
    expect(totals.lost).toBeGreaterThan(RUNS / 20);
    expect(totals.ordered, 'messages whose order was checked').toBeGreaterThan(RUNS * 10);
    // An epoch conflict happened inside the run (SYN-047 criterion 3).
    expect(totals.fenced, 'writes fenced after a failover').toBeGreaterThan(0);
    // Commits were stored while the Terms region was approved, and none changed it (PRM-047).
    expect(totals.approvedChecked, 'commits checked against an approval').toBeGreaterThan(0);
    for (const code of ['permission_denied', 'invalid_op', 'unavailable'])
      expect(codes.get(code) ?? 0, code).toBeGreaterThan(0);
    // Clients generate every step type (PRM-017 criterion 1), and every one reaches the log.
    for (const type of ALLOWED_STEP_TYPES) {
      expect(submitted.get(type) ?? 0, `${type} submitted`).toBeGreaterThan(0);
      expect(stored.get(type) ?? 0, `${type} stored`).toBeGreaterThan(0);
    }
  });

  it('reports a failing schedule with its seed and a shrunk sequence that replays (PRM-017)', () => {
    // A property made to fail: "no schedule crashes the room". The report and the replay are what
    // a real failure of the suite above would give.
    const property = fc.property(
      fc.array(op, { minLength: 1, maxLength: 120 }),
      fc.subarray(CAST, { minLength: 2 }),
      (ops, users) => {
        const { sim } = runOnce(ops, users, ['mallory']);
        if (sim.stats.crashes > 0) throw new Error(`regression: ${JSON.stringify({ users, ops })}`);
      },
    );
    const details = fc.check(property, { seed: 7, numRuns: 300 });
    expect(details.failed).toBe(true);
    const report = fc.defaultReportMessage(details) ?? '';
    expect(report).toMatch(/seed: 7/);
    expect(report).toMatch(/Counterexample/);
    expect(details.numShrinks).toBeGreaterThan(0);
    // The shrunk sequence is a few operations around a room crash; saved as JSON, it replays to
    // the same failure.
    const message = (details.errorInstance as Error).message;
    const saved = JSON.parse(message.slice(message.indexOf('{'))) as {
      users: UserName[];
      ops: Op[];
    };
    expect(saved.ops.length).toBeLessThanOrEqual(3);
    expect(saved.ops).toContainEqual({ k: 'crash', a: 0 });
    expect(runOnce(saved.ops, saved.users, ['mallory']).sim.stats.crashes).toBe(1);
  });
});
