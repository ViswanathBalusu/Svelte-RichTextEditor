/**
 * At most one publication per animation frame (UX-072, criterion 4; 02 §4). These properties run
 * `frameScheduler` against a simulated clock: microtasks and animation-frame callbacks are queues
 * that the test drains by hand, so every interleaving of requests, microtask checkpoints and frame
 * ticks is reachable. The scheduler is the one the command registry publishes through (UX-003).
 *
 * What they show: within one task phase (the window between two frame ticks) at most one
 * publication runs, and within one frame tick at most one runs; nothing is lost. What they do not
 * show: a publication in a task phase followed by one in the next frame tick lands before the same
 * paint (the window and the tick both precede it). That is the scheduler's current behaviour and is
 * recorded in the story's Notes; criterion 4 stays open on it. Browser rendering is not measured.
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
  it('runs at most one publication in each task phase between two frame ticks', () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 200 }), (ops) => {
        const { publications } = simulate(ops);
        const perWindow = new Map<number, number>();
        for (const p of publications) {
          if (p.where !== 'window') continue;
          perWindow.set(p.index, (perWindow.get(p.index) ?? 0) + 1);
        }
        for (const [, count] of perWindow) expect(count).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it('runs at most one publication in each animation frame tick', () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 200 }), (ops) => {
        const { publications } = simulate(ops);
        const perTick = new Map<number, number>();
        for (const p of publications) {
          if (p.where !== 'tick') continue;
          perTick.set(p.index, (perTick.get(p.index) ?? 0) + 1);
        }
        for (const [, count] of perTick) expect(count).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
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

  it('records the known gap: a publication in a task phase and one in the next tick both precede one paint', () => {
    const trace = simulate([{ kind: 'request' }, { kind: 'request' }]);
    // The first request publishes in the microtask; the second waits for the frame tick.
    expect(trace.publications).toEqual([
      { where: 'window', index: 0 },
      { where: 'tick', index: 0 },
    ]);
    expect(trace.requests).toBe(2);
  });

  it('merges requests made before the publication runs into one publication', () => {
    const trace = simulate([{ kind: 'request' }, { kind: 'request' }, { kind: 'request' }]);
    expect(trace.publications.length).toBe(2);
  });
});
