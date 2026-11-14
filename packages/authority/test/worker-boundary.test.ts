// SYN-001 criterion 5: the authority's pure functions run in a worker thread on structured-cloned
// plain data alone, and give the same results as in the test process.
import { Worker } from 'node:worker_threads';
import { Fragment, Slice } from 'prosemirror-model';
import { AddMarkStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { stepsToJson, type StepJson } from '../src/steps.ts';
import {
  type AuthorityRunInput,
  type AuthorityRunOutput,
  runAuthority,
} from './harness/authority-run.ts';
import { BASE_JSON, baseDoc, posInside, schema } from './fixtures.ts';

const insert = (at: string, text: string): Step => {
  const doc = baseDoc();
  const pos = posInside(doc, at);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};

const runInWorker = (input: AuthorityRunInput): Promise<AuthorityRunOutput> =>
  new Promise((resolve, reject) => {
    const w = new Worker(new URL('./harness/authority-worker.ts', import.meta.url), {
      workerData: input,
    });
    w.once('message', (m: AuthorityRunOutput) => {
      void w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });

describe('the authority in a worker thread (SYN-001 criterion 5)', () => {
  it('gives the same results in a worker as in the test process, from structured-cloned data', async () => {
    const input: AuthorityRunInput = {
      base: BASE_JSON,
      mine: stepsToJson([insert('pTerms000000002A', 'Hi ')]) as StepJson[],
      over: stepsToJson([insert('pIntro0000000001', 'Dear ')]) as StepJson[],
      ranges: [
        { from: 1, to: 4 },
        { from: 9, to: 9 },
      ],
    };
    // Everything that crosses the boundary is plain data: a structured clone is the same value.
    expect(structuredClone(input)).toEqual(input);

    const inProcess = runAuthority(input);
    const inWorker = await runInWorker(input);
    expect(inWorker).toEqual(inProcess);

    expect(inWorker.parsedMine).toEqual({ ok: true });
    expect(inWorker.parsedOver).toEqual({ ok: true });
    expect(inWorker.apply.ok).toBe(true);
    expect(inWorker.invariants).toEqual({ ok: true });
    expect(inWorker.rebase.ok).toBe(true);
    if (inWorker.rebase.ok) {
      expect(inWorker.rebase.dropped).toEqual([]);
      expect(inWorker.rebase.positions).toEqual([0]);
      // The rebased commit was mapped by the earlier insertion, so it is not the same steps.
      expect(inWorker.rebase.steps).not.toEqual(input.mine);
    }
  });

  it('returns a rejection code from the worker and does not crash it', async () => {
    const doc = baseDoc();
    const size = doc.content.size;
    // A mark step past the end throws inside prosemirror-transform: the result is invalid_op.
    const past = new AddMarkStep(size - 2, size + 30, schema.marks['bold']!.create());
    const input: AuthorityRunInput = {
      base: BASE_JSON,
      mine: stepsToJson([past]) as StepJson[],
      over: [],
      ranges: [{ from: 1, to: 2 }],
    };
    // A malformed commit is refused by parseSteps before any function runs on it.
    const inWorker = await runInWorker(input);
    expect(inWorker.parsedMine.ok).toBe(true);
    expect(inWorker.apply).toEqual({ ok: false, code: 'invalid_op' });
    expect(inWorker.invariants).toEqual({ ok: false, code: 'not_run' });
    expect(inWorker).toEqual(runAuthority(input));
  });

  it('refuses a malformed step list in the worker with a code, never a crash', async () => {
    const input: AuthorityRunInput = {
      base: BASE_JSON,
      mine: [{ stepType: 'docAttr', attrs: {} }] as unknown as StepJson[],
      over: [],
      ranges: [],
    };
    const inWorker = await runInWorker(input);
    expect(inWorker.parsedMine.ok).toBe(false);
    expect(inWorker.rebase).toEqual({ ok: false, code: 'not_run' });
  });
});
