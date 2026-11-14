/**
 * Extension hooks stay off the typing path (UX-054; 13 §7.2, §9). Criteria 2 and 3 are tested here
 * on the queue with an injected `later`: a notify never calls a hook and never waits for one, a hook
 * that throws or never resolves leaves typing alone, and the queue stays bounded (property tests).
 * `connectHooks`, which App.svelte calls with the core's revision, is tested here too; the typing
 * itself is tested in the browser (e2e/extensions.spec.ts).
 * Criterion 1 (the keystroke-to-paint measurement) and criterion 4 (the API documentation) are not
 * claimed: the harness and the documentation do not exist yet.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  HookQueue,
  afterPaint,
  connectHooks,
  type DocumentChangedEvent,
  type HookQueueOptions,
} from '../src/extensions/hooks.ts';

interface Harness<E> {
  readonly queue: HookQueue<E>;
  readonly errors: unknown[];
  readonly calls: E[];
  flush(): void;
}

/** A queue whose `later` callbacks run only when the test calls `flush`. */
function harness<E>(handler: (event: E) => unknown, capacity = 4, maxInFlight = 2): Harness<E> {
  const waiting: Array<() => void> = [];
  const errors: unknown[] = [];
  const calls: E[] = [];
  const options: HookQueueOptions<E> = {
    handler: (event) => {
      calls.push(event);
      return handler(event);
    },
    capacity,
    maxInFlight,
    later: (run) => void waiting.push(run),
    onError: (error) => void errors.push(error),
  };
  return {
    queue: new HookQueue(options),
    errors,
    calls,
    flush: () => {
      for (const run of waiting.splice(0)) run();
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('a notify only queues: the transaction never waits for a hook (UX-054, criterion 2)', () => {
  it('does not call the hook synchronously and returns nothing', () => {
    const h = harness<number>(() => undefined);
    const result: unknown = h.queue.notify(1);
    expect(result).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(h.queue.stats().pending).toBe(1);
    h.flush();
    expect(h.calls).toEqual([1]);
    expect(h.queue.stats().pending).toBe(0);
  });

  it('keeps the order of events for the hook', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 4 }), (events) => {
        const h = harness<number>(() => undefined, 8, 1);
        for (const e of events) h.queue.notify(e);
        h.flush();
        expect(h.calls).toEqual(events);
      }),
    );
  });

  it('defers delivery to the callback it was given, so a paint can come first', () => {
    const waiting: Array<() => void> = [];
    const seen: string[] = [];
    const queue = new HookQueue<string>({
      handler: (e) => void seen.push(e),
      capacity: 2,
      maxInFlight: 1,
      later: (run) => void waiting.push(run),
      onError: () => undefined,
    });
    queue.notify('keystroke');
    seen.push('paint');
    expect(seen).toEqual(['paint']);
    for (const run of waiting.splice(0)) run();
    expect(seen).toEqual(['paint', 'keystroke']);
  });
});

describe('a hook that throws or never resolves leaves typing alone (UX-054, criterion 3)', () => {
  it('reports a throwing hook and keeps delivering the next events', () => {
    const h = harness<number>((e) => {
      if (e === 1) throw new Error('slow path failed');
      return undefined;
    });
    expect(() => {
      h.queue.notify(1);
      h.queue.notify(2);
    }).not.toThrow();
    h.flush();
    expect(h.errors).toHaveLength(1);
    expect(h.calls).toEqual([1, 2]);
    expect(h.queue.stats()).toMatchObject({ delivered: 1, failed: 1, pending: 0 });
  });

  it('reports a rejected promise and carries on', async () => {
    const reason = new Error('rejected');
    const h = harness<number>((e) => (e === 1 ? Promise.reject(reason) : undefined));
    h.queue.notify(1);
    h.queue.notify(2);
    h.flush();
    await tick();
    expect(h.errors).toEqual([reason]);
    expect(h.calls).toEqual([1, 2]);
    expect(h.queue.stats().inFlight).toBe(0);
  });

  it('keeps notifying when the error sink itself throws', () => {
    const queue = new HookQueue<number>({
      handler: () => {
        throw new Error('boom');
      },
      capacity: 1,
      maxInFlight: 1,
      later: (run) => run(),
      onError: () => {
        throw new Error('sink');
      },
    });
    expect(() => queue.notify(1)).not.toThrow();
    expect(queue.stats().failed).toBe(1);
  });

  it('a hook that never resolves holds one slot and no more', () => {
    const h = harness<number>(() => new Promise<void>(() => undefined), 3, 1);
    for (let i = 0; i < 10; i++) h.queue.notify(i);
    h.flush();
    // The newest three events are kept (7, 8, 9); the first of them holds the only slot.
    expect(h.calls).toEqual([7]);
    expect(h.queue.stats()).toMatchObject({ inFlight: 1, pending: 2, dropped: 7 });
  });

  it('the pending queue and the in-flight calls stay bounded whatever the hook does (property)', async () => {
    type Op = { kind: 'notify' } | { kind: 'flush' } | { kind: 'settle'; at: number; ok: boolean };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.constant<Op>({ kind: 'notify' }),
      fc.constant<Op>({ kind: 'flush' }),
      fc.record({ kind: fc.constant('settle' as const), at: fc.nat(20), ok: fc.boolean() }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('sync', 'throw', 'defer'), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(op, { maxLength: 60 }),
        async (modes, capacity, maxInFlight, ops) => {
          const deferred: Array<{ resolve(): void; reject(e: unknown): void }> = [];
          let call = 0;
          const h = harness<number>(
            () => {
              const mode = modes[call++ % modes.length];
              if (mode === 'throw') throw new Error('x');
              if (mode === 'defer')
                return new Promise<void>((resolve, reject) => deferred.push({ resolve, reject }));
              return undefined;
            },
            capacity,
            maxInFlight,
          );
          let notified = 0;
          for (const step of ops) {
            if (step.kind === 'notify') {
              notified++;
              expect(() => h.queue.notify(notified)).not.toThrow();
            } else if (step.kind === 'flush') {
              h.flush();
            } else {
              const d = deferred[step.at];
              if (d && step.ok) d.resolve();
              else if (d) d.reject(new Error('later'));
              await tick();
            }
            const s = h.queue.stats();
            expect(s.pending).toBeLessThanOrEqual(capacity);
            expect(s.inFlight).toBeLessThanOrEqual(maxInFlight);
            // Every notified event is pending, dropped, finished, failed or in flight, exactly once.
            expect(notified).toBe(s.dropped + s.pending + s.delivered + s.failed + s.inFlight);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('bounds are required and checked', () => {
  it('refuses a capacity or an in-flight limit below 1', () => {
    const base = { handler: () => undefined, later: () => undefined, onError: () => undefined };
    expect(() => new HookQueue({ ...base, capacity: 0, maxInFlight: 1 })).toThrow(RangeError);
    expect(() => new HookQueue({ ...base, capacity: 1, maxInFlight: 0 })).toThrow(RangeError);
    expect(() => new HookQueue({ ...base, capacity: 1.5, maxInFlight: 1 })).toThrow(RangeError);
  });

  it('ignores events after destroy', () => {
    const h = harness<number>(() => undefined);
    h.queue.notify(1);
    h.queue.destroy();
    h.queue.notify(2);
    h.flush();
    expect(h.calls).toEqual([]);
  });
});

/** A revision view like the core's: `set` notifies its subscribers synchronously. */
function revisionView(start = 0) {
  let value = start;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: number) {
      value = next;
      for (const l of listeners) l();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

describe('connectHooks feeds the hooks from the core revision (the shell path, App.svelte)', () => {
  it('only enqueues on a change, and delivers after `later` runs', () => {
    const revision = revisionView(3);
    const waiting: Array<() => void> = [];
    const seen: DocumentChangedEvent[] = [];
    const hooks = connectHooks(
      revision,
      { handlers: [(e) => void seen.push(e)], capacity: 4, maxInFlight: 1, onError: () => {} },
      (run) => void waiting.push(run),
    );
    revision.set(3);
    expect(waiting).toHaveLength(0);
    revision.set(4);
    expect(seen).toEqual([]);
    expect(hooks.stats()[0]?.pending).toBe(1);
    for (const run of waiting.splice(0)) run();
    expect(seen).toEqual([{ kind: 'changed', revision: 4 }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    hooks.stop();
    expect(revision.listeners).toBe(0);
    revision.set(5);
    expect(waiting).toHaveLength(0);
  });

  it('keeps every hook bounded while one throws and one never resolves (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 20 }),
        (changes, capacity, maxInFlight, flushEvery) => {
          const revision = revisionView();
          const waiting: Array<() => void> = [];
          const errors: unknown[] = [];
          const good: number[] = [];
          const hooks = connectHooks(
            revision,
            {
              handlers: [
                () => {
                  throw new Error('hook');
                },
                () => new Promise(() => {}),
                (e) => void good.push(e.revision),
              ],
              capacity,
              maxInFlight,
              onError: (e) => void errors.push(e),
            },
            (run) => void waiting.push(run),
          );
          for (let n = 1; n <= changes; n++) {
            // The change returns with nothing called: only the later callbacks run hooks.
            const before = good.length + errors.length;
            revision.set(n);
            expect(good.length + errors.length).toBe(before);
            if (n % flushEvery === 0) for (const run of waiting.splice(0)) run();
            for (const s of hooks.stats()) {
              expect(s.pending).toBeLessThanOrEqual(capacity);
              expect(s.inFlight).toBeLessThanOrEqual(maxInFlight);
            }
          }
          for (const run of waiting.splice(0)) run();
          const [throwing, hanging, ok] = hooks.stats();
          expect(throwing!.failed + throwing!.dropped).toBe(changes);
          expect(errors).toHaveLength(throwing!.failed);
          expect(hanging!.inFlight).toBeLessThanOrEqual(maxInFlight);
          expect(hanging!.inFlight + hanging!.pending + hanging!.dropped).toBe(changes);
          expect(ok!.delivered + ok!.dropped).toBe(changes);
          expect(good.at(-1)).toBe(changes);
          hooks.stop();
        },
      ),
    );
  });
});

describe('afterPaint runs its callback later, not inline', () => {
  it('calls back asynchronously in a runtime without requestAnimationFrame', async () => {
    let ran = false;
    afterPaint(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    await tick();
    await tick();
    expect(ran).toBe(true);
  });
});
