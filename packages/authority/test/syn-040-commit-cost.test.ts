// SYN-040: the cost of a commit through the room, stage by stage (04 §5 steps 2 to 7; 04 §12), and
// the budget that fails the run when a stage grows. The numbers come from `test/harness/commit-cost.ts`.
//
// The budget is the spec's "well under a millisecond of CPU" for a typical commit (04 §12), read as
// 1 ms, the most "well under" can mean (`TARGET_MS` in the harness). It holds for the median of each
// stage of steps 2 to 7 and of their sum, for a commit at the head and for a rebased one, on the
// documents of 1, 20 and 100 pages. Step 6 meets it since the room validates the result of a commit
// from the nodes the commit changed (`CommitValidator`, ADR 0422) and step 7 since the scope
// difference reads only the children of the body that differ (`diffScopes`).
//
// A measurement on a busy runner can exceed a budget this close to the target without a
// regression, so a failing document is measured once more with more runs and fails only if the
// second measurement fails too. A real regression fails both.
import { loadDocument } from '@docedit/corpus';
import { CommitValidator } from '@docedit/model/validate';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { AttrStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps } from '../src/rebase.ts';
import {
  type CommitCost,
  STAGES,
  TARGET_MS,
  budgetViolations,
  measureCommit,
  tabulate,
  toJson,
} from './harness/commit-cost.ts';

const FIRST = { runs: { typical: 15, rebased: 8, worst: 2 }, warmup: 3, rebaseDistance: 3 };
const SECOND = { runs: { typical: 41, rebased: 21, worst: 2 }, warmup: 5, rebaseDistance: 3 };

async function measure(doc: string, opts: typeof FIRST): Promise<CommitCost[]> {
  return [await measureCommit(doc, 'typical', opts), await measureCommit(doc, 'rebased', opts)];
}

describe('the cost of a commit through the room (SYN-040)', () => {
  for (const doc of ['pages-1', 'pages-20', 'pages-100']) {
    it(`${doc}: every stage is timed, and a typical commit stays inside the budget`, async () => {
      let results = await measure(doc, FIRST);
      if (budgetViolations(results).length > 0) results = await measure(doc, SECOND);
      const table = tabulate(results);
      const [typical, rebased] = results as [CommitCost, CommitCost];

      for (const r of results) {
        expect(r.refused, `${r.kind}: ${r.reason}\n${table}`).toBe(0);
        // The stages account for nearly all of the `submit` call (the rest is the step-8 stamp).
        expect(r.stagesTotal.median).toBeLessThanOrEqual(r.submit.median);
      }
      // A commit at the head takes no rebase; a rebased one does.
      expect(typical.stages.rebase.median).toBe(0);
      expect(rebased.stages.rebase.median).toBeGreaterThan(0);

      // Step 6 is answered from the nodes the commit changed (ADR 0422), the whole document once at most
      // (the first commit, whose document before is not yet known to be valid).
      for (const r of results)
        expect(r.validation.incremental, `${r.kind} validation\n${table}`).toBeGreaterThan(0);
      // Each run starts a room, so a measurement validates in full at most for its first commit.
      expect(typical.validation.full).toBeLessThanOrEqual(1);

      // The budget: no stage, and not their sum, reaches the target.
      expect(budgetViolations(results), table).toEqual([]);
    });
  }

  it('times a commit of the limit of 500 steps, and names every stage of steps 2 to 7', async () => {
    const worst = await measureCommit('pages-1', 'worst', {
      runs: { typical: 1, rebased: 1, worst: 2 },
      warmup: 1,
      rebaseDistance: 3,
    });
    expect(worst.steps).toBe(500);
    expect(worst.refused, worst.reason).toBe(0);
    expect(Object.keys(worst.stages).sort()).toEqual([...STAGES].sort());
    // Validating the step JSON is the stage that grows with the number of steps.
    expect(worst.stages.validate.median).toBeGreaterThan(0);
    // The commit of 500 steps has no target in the spec: it is reported, not gated.
    expect(budgetViolations([worst])).toEqual([]);
  });
});

describe('the gate fails when the budget is exceeded (SYN-040 criterion 2)', () => {
  it('reports a stage, and the sum of the stages, that reach the target', async () => {
    const [typical] = await measure('pages-1', {
      ...FIRST,
      runs: { typical: 5, rebased: 3, worst: 1 },
    });
    expect(budgetViolations([typical!])).toEqual([]);
    // The same result with one stage as slow as the target, and with the sum over it.
    const slow: CommitCost = {
      ...typical!,
      stages: { ...typical!.stages, permissions: { median: TARGET_MS, p99: TARGET_MS } },
    };
    expect(budgetViolations([slow]).join('\n')).toMatch(/step 7 permissions: median 1\.000 ms/);
    const sum: CommitCost = { ...typical!, stagesTotal: { median: TARGET_MS + 0.5, p99: 9 } };
    expect(budgetViolations([sum]).join('\n')).toMatch(/steps 2 to 7: median 1\.500 ms/);
    // A tighter target fails the real result: the gate compares with the number it is given.
    expect(budgetViolations([typical!], 0.000001).length).toBeGreaterThanOrEqual(STAGES.length);
    // A refused commit is never a cheap commit.
    expect(budgetViolations([{ ...typical!, refused: 1, reason: 'invalid_op' }])[0]).toMatch(
      /1 commits refused/,
    );
  });

  it('writes the results as JSON with the machine and the budget, for storage per commit', async () => {
    const results = await measure('pages-1', {
      ...FIRST,
      runs: { typical: 3, rebased: 2, worst: 1 },
    });
    const json = JSON.parse(toJson(results, 'abc1234')) as {
      kind: string;
      commit: string;
      machine: string;
      budget: { targetMs: number };
      results: CommitCost[];
    };
    expect(json).toMatchObject({ kind: 'authority-commit-cost', commit: 'abc1234' });
    expect(json.budget.targetMs).toBe(TARGET_MS);
    expect(json.machine).toMatch(/Node\.js/);
    expect(json.results.map((r) => r.kind)).toEqual(['typical', 'rebased']);
  });
});

describe('step 6 from the changed nodes gives the answer of the whole document (SYN-040; ADR 0422)', () => {
  it('accepts and refuses the same commits as validating the result in full', async () => {
    const { envelope } = await loadDocument('pages-1');
    const before = cdmSchema().nodeFromJSON(envelope.doc);
    // The first paragraph with an identifier, and the position inside the first one with text.
    let para: { pos: number; node: Node } | null = null;
    before.descendants((n, pos) => {
      if (para === null && n.type.name === 'paragraph' && n.content.size >= 2)
        para = { pos, node: n };
      return para === null;
    });
    const at = para as unknown as { pos: number; node: Node };
    const typing = new ReplaceStep(
      at.pos + 1,
      at.pos + 1,
      new Slice(Fragment.from(before.type.schema.text('x')), 0, 0),
    );
    // The same identifier twice (I2), and a paragraph style that does not exist (I4).
    const twin = new ReplaceStep(at.pos, at.pos, new Slice(Fragment.from(at.node), 0, 0));
    const wrongStyle = new AttrStep(at.pos, 'style', 'NoSuchStyle');
    const ctx = { requires: envelope.requires, retiredRegionIds: new Set<string>() };
    for (const [name, step] of [
      ['typing', typing],
      ['a twin identifier', twin],
      ['a missing style', wrongStyle],
    ] as const) {
      const applied = applySteps(before, [step]);
      if (!applied.ok) throw new Error(`${name}: ${applied.reason}`);
      const after = applied.value.doc;
      const full = checkInvariants(before, after, [step], applied.value.docs, ctx);
      const validator = new CommitValidator();
      const fast = checkInvariants(before, after, [step], applied.value.docs, {
        ...ctx,
        validator,
      });
      expect(full.ok, name).toBe(name === 'typing');
      expect(fast, name).toEqual(full);
      // Once more on the same validator: the answer does not depend on what it has seen.
      expect(
        checkInvariants(before, after, [step], applied.value.docs, { ...ctx, validator }),
        name,
      ).toEqual(full);
    }
  });
});
