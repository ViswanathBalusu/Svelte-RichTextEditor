// Snapshot commits under the faults of S3 (SYN-005, SYN-030, SYN-047): the control plane restores
// earlier versions as snapshot commits while clients edit, writes fail or are lost, grants change
// and rooms fail over. Every client converges, nothing is stored twice (a restore retried with its
// deterministic id included), and every guarantee of the main suite holds. In memory only: the
// PostgreSQL run of the main suite does not store snapshot commits yet.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CAST, opArbitrary } from './harness/ops.ts';
import { Simulation } from './harness/sim.ts';

const RUNS = Number(process.env['S3_SNAPSHOT_RUNS'] ?? 150);

describe('S3 with snapshot commits', () => {
  it('converges with restores among the edits, failures and failovers', () => {
    const totals = { snapshots: 0, resets: 0, requested: 0, recovered: 0, commits: 0 };
    const answers = new Map<string, number>();
    fc.assert(
      fc.property(
        fc.array(opArbitrary(2), { minLength: 60, maxLength: 240 }),
        fc.subarray(CAST, { minLength: 2 }),
        (ops, users) => {
          const sim = new Simulation({ users, malicious: ['mallory'], snapshots: true });
          sim.run(ops);
          const failures = sim.check();
          totals.snapshots += sim.storage.log.filter((c) => c.kind === 'snapshot').length;
          totals.commits += sim.storage.log.filter((c) => c.kind === 'steps').length;
          totals.requested += sim.stats.snapshotsRequested;
          for (const c of sim.clients) {
            totals.resets += c.resets;
            totals.recovered += c.recovered;
          }
          for (const [k, v] of sim.stats.snapshotAnswers) answers.set(k, (answers.get(k) ?? 0) + v);
          expect(
            failures,
            `${failures.join('\n')}\nregression: ${JSON.stringify({ users, ops })}`,
          ).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
    console.log(
      `S3 with snapshots over ${RUNS} runs: ${JSON.stringify(totals)}; control-plane answers ${JSON.stringify(Object.fromEntries(answers))}`,
    );
    expect(totals.snapshots).toBeGreaterThan(RUNS / 2);
    expect(totals.resets).toBeGreaterThan(RUNS / 2);
    expect(totals.commits).toBeGreaterThan(RUNS / 2);
  });
});
