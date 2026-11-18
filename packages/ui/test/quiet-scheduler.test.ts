/**
 * The quiet scheduler (UX-066 criterion 5): a burst of requests costs one run, started after the
 * quiet period and in an idle period when the platform has one, and a run that has not started can
 * be dropped. The timer is simulated, so the test needs no clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { browserIdle, quietScheduler } from '../src/shell/quiet-scheduler.ts';

function simulatedTimers() {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number) {
        const id = next++;
        queue.set(id, { at: now + ms, fn });
        return id;
      },
      clear(handle: unknown) {
        queue.delete(handle as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, item] of [...queue]) {
        if (item.at <= now) {
          queue.delete(id);
          item.fn();
        }
      }
    },
    waiting: () => queue.size,
  };
}

describe('the quiet scheduler', () => {
  it('runs once, after the quiet period, however many requests came before', () => {
    const clock = simulatedTimers();
    const scheduler = quietScheduler({ quietMs: 250, timers: clock.timers });
    const run = vi.fn();
    for (let i = 0; i < 100; i++) {
      scheduler.request(run);
      clock.advance(10);
    }
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(true);
    // The last request was made 10 ms ago, so 240 ms of the quiet period remain.
    clock.advance(239);
    expect(run).not.toHaveBeenCalled();
    clock.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
    clock.advance(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs the latest request, not an earlier one', () => {
    const clock = simulatedTimers();
    const scheduler = quietScheduler({ quietMs: 50, timers: clock.timers });
    const first = vi.fn();
    const last = vi.fn();
    scheduler.request(first);
    scheduler.request(last);
    clock.advance(50);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledOnce();
  });

  it('drops a run that has not started, and a run after one is possible', () => {
    const clock = simulatedTimers();
    const scheduler = quietScheduler({ quietMs: 50, timers: clock.timers });
    const run = vi.fn();
    scheduler.request(run);
    scheduler.cancel();
    expect(clock.waiting()).toBe(0);
    clock.advance(1000);
    expect(run).not.toHaveBeenCalled();
    scheduler.request(run);
    clock.advance(50);
    expect(run).toHaveBeenCalledOnce();
  });

  it('starts the run in an idle period when it is given one, and cancels it there', () => {
    const clock = simulatedTimers();
    let start: (() => void) | null = null;
    const stopIdle = vi.fn();
    const scheduler = quietScheduler({
      quietMs: 50,
      timers: clock.timers,
      whenIdle: (fn) => {
        start = fn;
        return stopIdle;
      },
    });
    const run = vi.fn();
    scheduler.request(run);
    clock.advance(50);
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(true);
    scheduler.cancel();
    expect(stopIdle).toHaveBeenCalledOnce();
    scheduler.request(run);
    clock.advance(50);
    start!();
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.pending).toBe(false);
  });

  it('browserIdle starts at once where the platform has no idle callback', () => {
    const run = vi.fn();
    const g = globalThis as { requestIdleCallback?: unknown };
    const saved = g.requestIdleCallback;
    delete g.requestIdleCallback;
    try {
      browserIdle()(run);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      if (saved !== undefined) g.requestIdleCallback = saved;
    }
  });
});
