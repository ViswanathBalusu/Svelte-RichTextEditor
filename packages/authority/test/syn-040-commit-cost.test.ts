// SYN-040: the cost of a commit through the room, stage by stage (04 §5 steps 2 to 7; 04 §12), and
// the budgets that fail the run when a stage grows. The numbers come from `test/harness/commit-cost.ts`.
//
// Two kinds of budget, kept apart so that neither is read as the other:
//
// - TARGET_MS is the spec's "well under a millisecond of CPU" for a typical commit (04 §12), read
//   as 1 ms as the most that "well under" can mean. Stages 2 to 5 and the step-JSON check meet it
//   on every corpus size and are held to it. Steps 6 and 7 do not: step 6 validates the whole
//   document (`validateDoc`), so it grows with the document. They are held to a regression ceiling.
// - CEILING_MS is that ceiling: a generous multiple (5 to 25 times) of the median measured on 2026-11-26 on the
//   development machine (i9-10900KF; see the Evidence of SYN-040), so that a slower runner passes
//   and a stage that gets several times slower fails. The ceilings are provisional: decision 22 says
//   tolerances stay provisional until they are measured on the dedicated runner.
import { describe, expect, it } from 'vitest';
import type { CommitStage } from '../src/room/room.ts';
import { STAGES, measureCommit, tabulate, type CommitCost } from './harness/commit-cost.ts';

const TARGET_MS = 1;
const MEETS_TARGET: readonly CommitStage[] = ['dedupe', 'base', 'validate', 'rebase', 'apply'];

/** Regression ceilings for the stages that do not meet the target, by corpus document (ms). */
const CEILING_MS: Record<string, Record<'invariants' | 'permissions', number>> = {
  'pages-1': { invariants: 75, permissions: 5 },
  'pages-20': { invariants: 400, permissions: 10 },
  'pages-100': { invariants: 1200, permissions: 50 },
};

const RUNS = { typical: 5, rebased: 3, worst: 2 };
const FAST = { runs: RUNS, warmup: 1, rebaseDistance: 3 };

describe('the cost of a commit through the room (SYN-040)', () => {
  for (const doc of ['pages-1', 'pages-20', 'pages-100']) {
    it(`${doc}: every stage is timed, and each stays inside its budget`, async () => {
      const typical = await measureCommit(doc, 'typical', FAST);
      const rebased = await measureCommit(doc, 'rebased', FAST);
      const results: CommitCost[] = [typical, rebased];
      const table = tabulate(results);

      for (const r of results) {
        expect(r.refused, `${r.kind}: ${r.reason}\n${table}`).toBe(0);
        expect(r.accepted).toBe(RUNS[r.kind]);
        // The stages account for nearly all of the `submit` call (the rest is the step-8 stamp).
        expect(r.stagesTotal.median).toBeLessThanOrEqual(r.submit.median);
      }
      // A commit at the head takes no rebase; a rebased one does.
      expect(typical.stages.rebase.median).toBe(0);
      expect(rebased.stages.rebase.median).toBeGreaterThan(0);

      for (const r of results) {
        for (const stage of MEETS_TARGET)
          expect(r.stages[stage].median, `${r.kind} ${stage}\n${table}`).toBeLessThan(TARGET_MS);
        for (const stage of ['invariants', 'permissions'] as const)
          expect(r.stages[stage].median, `${r.kind} ${stage}\n${table}`).toBeLessThan(
            CEILING_MS[doc]![stage],
          );
      }
    });
  }

  it('times a commit of the limit of 500 steps, and names every stage of steps 2 to 7', async () => {
    const worst = await measureCommit('pages-1', 'worst', FAST);
    expect(worst.steps).toBe(500);
    expect(worst.refused, worst.reason).toBe(0);
    expect(Object.keys(worst.stages).sort()).toEqual([...STAGES].sort());
    // Validating the step JSON is the stage that grows with the number of steps.
    expect(worst.stages.validate.median).toBeGreaterThan(0);
  });
});
