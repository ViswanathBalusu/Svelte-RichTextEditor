/**
 * The node lease (BE-018) on its own: a fake monotonic clock, a fake database clock and fake
 * timers, so that every case is deterministic. The rooms it fences are tested with the room host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeLease } from './lease.ts';
import { MemoryNodeLeases } from './memory-ports.ts';
import type { LeaseSettings } from './settings.ts';

const settings: LeaseSettings = { durationMs: 15_000, renewMs: 3000, marginMs: 1000 };

/** The node's monotonic clock (ms), moved only by `advance`. */
let mono = 0;
/** The database clock (ms), moved only by the test. */
let dbNow = 1_700_000_000_000;

/** Moves the monotonic clock and the fake timers together, in small steps, so no timer is skipped. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 100) {
    mono += Math.min(100, left);
    await vi.advanceTimersByTimeAsync(Math.min(100, left));
  }
}

function lease(over: { store?: MemoryNodeLeases; settings?: Partial<LeaseSettings> } = {}) {
  const store = over.store ?? new MemoryNodeLeases(() => dbNow);
  const lost: string[] = [];
  const errors: unknown[] = [];
  const l = new NodeLease({
    store,
    node: 'node-a',
    settings: { ...settings, ...over.settings },
    monotonic: () => mono,
    onLost: (why) => lost.push(why),
    onError: (e) => errors.push(e),
  });
  return { l, store, lost, errors };
}

let stopLater: Array<() => Promise<void>> = [];
beforeEach(() => {
  mono = 0;
  dbNow = 1_700_000_000_000;
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(async () => {
  for (const stop of stopLater) await stop();
  stopLater = [];
  vi.useRealTimers();
});

describe('the node lease renews on its own (BE-018)', () => {
  it('renews every renewMs for the lease length, and the database decides when it expires', async () => {
    const { l, store } = lease();
    stopLater.push(() => l.stop(false));
    const renew = vi.spyOn(store, 'renew');
    expect(await l.start()).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenLastCalledWith('node-a', 15_000);
    // "Every few seconds": a renewal at each renewMs while the node runs.
    await advance(9000);
    expect(renew).toHaveBeenCalledTimes(4);
    expect(l.proven).toBe(true);
    expect(await store.alive('node-a')).toBe(true);
    // The database expires the lease by its own clock once no renewal arrives.
    await l.stop(false);
    dbNow += 15_000;
    expect(await store.alive('node-a')).toBe(false);
  });

  it('keeps proving the lease while renewals succeed, and reports nothing', async () => {
    const { l, lost } = lease();
    stopLater.push(() => l.stop(false));
    await l.start();
    await advance(60_000);
    expect(l.proven).toBe(true);
    expect(lost).toEqual([]);
    expect(l.stats.failed).toBe(0);
  });
});

describe('a node that cannot prove its lease stops (BE-018)', () => {
  it('reports the loss once, when its own monotonic clock passes the last proven validity', async () => {
    const { l, store, lost, errors } = lease();
    stopLater.push(() => l.stop(false));
    expect(await l.start()).toBe(true);
    // Renewals now fail: the database is unreachable. The last success was sent at 0, so the
    // lease is proven until 15,000 - 1,000 = 14,000 on the node's own clock.
    store.failing = true;
    await advance(13_000);
    expect(l.proven).toBe(true);
    expect(lost).toEqual([]);
    await advance(2_000);
    expect(l.proven).toBe(false);
    expect(lost).toEqual(['the node lease could not be proved']);
    // Further renewals keep failing, and the loss is not reported twice.
    await advance(10_000);
    expect(lost).toHaveLength(1);
    expect(l.stats).toMatchObject({ lost: 1 });
    expect(l.stats.failed).toBeGreaterThan(1);
    expect(errors.length).toBe(l.stats.failed);
  });

  it('does not prove a lease it never obtained', async () => {
    const store = new MemoryNodeLeases(() => dbNow);
    store.failing = true;
    const { l } = lease({ store });
    stopLater.push(() => l.stop(false));
    expect(await l.start()).toBe(false);
    expect(l.proven).toBe(false);
  });
});

describe('the outcome depends only on the database clock and the monotonic clock (BE-018)', () => {
  it('ignores a stepped system clock, forward or back', async () => {
    const { l, store } = lease();
    stopLater.push(() => l.stop(false));
    await l.start();
    const before = l.remainingMs;
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(l.remainingMs).toBe(before);
    expect(l.proven).toBe(true);
    vi.setSystemTime(Date.now() - 7_200_000);
    expect(l.remainingMs).toBe(before);
    expect(l.proven).toBe(true);
    // Renewals stop working, and the loss still comes from the monotonic clock alone.
    store.failing = true;
    await advance(15_000);
    expect(l.proven).toBe(false);
  });

  it('is not moved by a stepped database clock for this node', async () => {
    const { l, store } = lease();
    stopLater.push(() => l.stop(false));
    await l.start();
    // The database clock steps an hour backwards: this node's own proof is unchanged, and the
    // database still counts the lease as alive until its own expiry.
    dbNow -= 3_600_000;
    expect(l.proven).toBe(true);
    expect(await store.alive('node-a')).toBe(true);
  });
});

describe('ending the lease (BE-018)', () => {
  it('releases the lease so that other nodes need not wait for it to expire', async () => {
    const { l, store } = lease();
    const renew = vi.spyOn(store, 'renew');
    await l.start();
    await l.stop(true);
    expect(await store.alive('node-a')).toBe(false);
    expect(l.proven).toBe(false);
    // Once stopped, the node renews nothing more.
    const calls = renew.mock.calls.length;
    await advance(30_000);
    expect(renew.mock.calls.length).toBe(calls);
    expect(await l.renew()).toBe(false);
  });
});
