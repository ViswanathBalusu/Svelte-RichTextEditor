/**
 * At most one publication per animation frame (UX-072, criterion 4; 02 §4; owner decision 93 of
 * 2026-11-17). These properties run `frameScheduler` against a simulated clock: microtasks and
 * animation-frame callbacks are queues that the test drains by hand, so every interleaving of
 * requests, microtask checkpoints and frame ticks is reachable. The scheduler is the one the command
 * registry publishes through (UX-003).
 *
 * The paint of frame k comes after tick k. A publication in the task phase before tick k and one in
 * tick k itself both land before that paint, so the test counts both against paint k. Browser
 * rendering is not measured here; the Svelte update per publication is not either.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { frameScheduler } from '../src/commands/schedule.ts';

type Op = { kind: 'request' } | { kind: 'tick' };

interface Publication {
  /** The window index (the task phase before tick `window`) or the tick index. */
  where: 'window' | 'tick';
  index: number;
}

interface Trace {
  publications: Publication[];
  requests: number;
  /** Whether a request was still unpublished after the two final frame ticks. */
  pendingAfterFlush: boolean;
}

/** Runs a sequence of operations against a simulated clock and records what published. */
function simulate(ops: readonly Op[]): Trace {
  const frames: Array<() => void> = [];
  const microtasks: Array<() => void> = [];
  const drain = () => {
    while (microtasks.length > 0) microtasks.shift()!();
  };

  let window = 0;
  let tick = 0;
  let inTick = false;
  let dirty = false;
  const publications: Publication[] = [];

  const scheduler = frameScheduler(
    (callback) => void frames.push(callback),
    (callback) => void microtasks.push(callback),
  );

  // The registry's flush: it publishes once, then notifies its listeners.
  const flush = () => {
    dirty = false;
    publications.push({ where: inTick ? 'tick' : 'window', index: inTick ? tick : window });
    scheduler.published();
  };

  const runTick = () => {
    inTick = true;
    drain();
    const batch = frames.splice(0);
    for (const callback of batch) {
      callback();
      drain();
    }
    inTick = false;
    tick += 1;
    window += 1;
  };

  let requests = 0;
  for (const op of ops) {
    if (op.kind === 'request') {
      requests += 1;
      dirty = true;
      scheduler.request(flush);
      drain();
    } else {
      runTick();
    }
  }
  // Two frame ticks with the microtasks between them: every requested publication has run.
  runTick();
  runTick();
  return {
    publications,
    requests,
    pendingAfterFlush: dirty,
  };
}

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Op>({ kind: 'request' }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: 'tick' }) },
);

describe('at most one publication per animation frame (UX-072, criterion 4)', () => {
  it('runs at most one publication before each paint (the task phase before a tick, and the tick)', () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 200 }), (ops) => {
        const { publications } = simulate(ops);
        const perPaint = new Map<number, number>();
        for (const p of publications) perPaint.set(p.index, (perPaint.get(p.index) ?? 0) + 1);
        for (const [, count] of perPaint) expect(count).toBeLessThanOrEqual(1);
      }),
      { numRuns: 1000 },
    );
  });

  it('never leaves a requested publication unrun after two frame ticks', () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 200 }), (ops) => {
        const trace = simulate(ops);
        expect(trace.pendingAfterFlush).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('holds a second publication back to the tick after the paint of the first', () => {
    const trace = simulate([{ kind: 'request' }, { kind: 'request' }]);
    // The first request publishes in the microtask of window 0; the second waits for tick 1.
    expect(trace.publications).toEqual([
      { where: 'window', index: 0 },
      { where: 'tick', index: 1 },
    ]);
    expect(trace.requests).toBe(2);
  });

  it('publishes a change that comes in the frame after a quiet one at once', () => {
    const trace = simulate([
      { kind: 'request' },
      { kind: 'tick' },
      { kind: 'tick' },
      { kind: 'request' },
    ]);
    expect(trace.publications).toEqual([
      { where: 'window', index: 0 },
      { where: 'window', index: 2 },
    ]);
  });

  it('merges requests made before the publication runs into one publication', () => {
    const trace = simulate([{ kind: 'request' }, { kind: 'request' }, { kind: 'request' }]);
    expect(trace.publications.length).toBe(2);
  });
});
