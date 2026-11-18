/**
 * BE-023 criterion 2: a transient authority has no subscribers and no timers, and holds no memory
 * after it exits (06 §2.2, last paragraph). The authority is the one `RoomHost.apply` runs on a
 * document with no open room, over the in-memory stores.
 *
 * - Timers: `setTimeout` and `setInterval` are wrapped for the length of the run; every timer the
 *   run starts must have fired or been cleared when it exits.
 * - Subscribers: no room is registered and no channel or connection exists for the document, so
 *   nobody can be subscribed; the open-room gauge reads 0.
 * - Memory: the permission data the room is given is a fresh object the test keeps only a weak
 *   reference to, and so is the log array. After a garbage collection (forced through V8's
 *   `--expose-gc`, set at run time) both are gone, which they would not be if the room, or
 *   anything the room hangs on, still referred to them.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { GrantStore, LogStore } from '../../src/storage/types.ts';
import { insertText } from './client.ts';
import { memoryStores, startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

async function collect(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
}

/** Wraps the timer functions; `live()` lists the timers started since that neither fired nor were cleared. */
function trackTimers(): { live(): number; stop(): void } {
  const live = new Set<unknown>();
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const h = real.setTimeout(
      (...a: unknown[]) => {
        live.delete(h);
        fn(...a);
      },
      ms,
      ...args,
    );
    live.add(h);
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
    live.delete(h);
    real.clearTimeout(h);
  }) as typeof clearTimeout;
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const h = real.setInterval(fn, ms, ...args);
    live.add(h);
    return h;
  }) as typeof setInterval;
  globalThis.clearInterval = ((h: Parameters<typeof clearInterval>[0]) => {
    live.delete(h);
    real.clearInterval(h);
  }) as typeof clearInterval;
  return {
    live: () => live.size,
    stop() {
      Object.assign(globalThis, real);
    },
  };
}

describe('a transient authority holds nothing after it exits (BE-023 criterion 2)', () => {
  it('leaves no timer, no registered room, no channel and no memory behind', async () => {
    const s = memoryStores();
    const weak: Array<WeakRef<object>> = [];
    // The permission data and the log the room is built from are fresh objects, watched weakly.
    const grants = new Proxy(s.memory, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === 'current')
          return async (...args: Parameters<GrantStore['current']>) => {
            const copy = { ...(await target.current(...args)) };
            weak.push(new WeakRef(copy));
            return copy;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as GrantStore;
    const logs = new Proxy(s.memory, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === 'read')
          return async (...args: Parameters<LogStore['read']>) => {
            const copy = [...(await target.read(...args))];
            weak.push(new WeakRef(copy));
            return copy;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as LogStore;

    const p = await startPlane({ stores: s, deps: { grants, logs } });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    weak.length = 0;

    const timers = trackTimers();
    let started: number;
    try {
      const r = await p.plane.host.apply(ref, {
        kind: 'author',
        id: uuid7(),
        origin: 'prefill',
        actor: 'system',
        base: 0,
        steps: [insertText(intro(), 'Prefilled')],
      });
      expect(r.seq).toBe(1);
      started = timers.live();
    } finally {
      timers.stop();
    }
    expect(started, 'timers started by the run and still pending').toBe(0);

    // No subscriber: no room, no transient authority, nobody connected to the plane.
    expect(p.plane.host.rooms).toHaveLength(0);
    expect(p.plane.host.get(ref)).toBeUndefined();
    expect(p.plane.host.transientCount).toBe(0);
    // The gauges have no series left (or read 0): no open room and no open connection.
    expect(p.plane.metrics()).not.toMatch(/^dep_(open_rooms|connections)\{[^}]*\} [1-9]/m);

    // No memory: what the room was given is collectable.
    expect(weak.length).toBeGreaterThanOrEqual(2);
    await collect();
    expect(weak.filter((w) => w.deref() !== undefined)).toHaveLength(0);
  });
});
