/**
 * Instrumented counters for FE-006 criterion 3 (02 §2.1): what an editor holds open while it lives,
 * counted in the page and read back after it is destroyed, without any garbage collection.
 *
 * `installCounters` wraps the page's own timers, event targets, observers, workers, IndexedDB,
 * WebSocket and BroadcastChannel. Each wrapper records a resource when it is acquired and forgets it
 * when it is released. `readCounters` lists what is still held. The wrappers change no behaviour.
 *
 * A listener counts only when its target outlives the editor: the window, the document, the root
 * and body elements, media query lists, the visual viewport, and elements outside the editor. A
 * listener on a node inside the editor's own tree goes with the tree and is not a leak.
 */
import type { Page } from '@playwright/test';

export interface Held {
  /** Listeners on targets that outlive the editor: `<target>:<type>:<capture>`. */
  listeners: string[];
  /** Observers that observe something and were not disconnected: the class name. */
  observers: string[];
  /** Timers set and neither fired nor cleared (the stack of where it was set, first line). */
  timers: string[];
  /** Animation frames requested and neither run nor cancelled. */
  frames: number;
  /** Workers not terminated. */
  workers: number;
  /** IndexedDB handles opened and not closed: the database name. */
  idb: string[];
  /** WebSockets not closed and broadcast channels not closed. */
  channels: string[];
  /** How many resources of each kind were ever acquired since the counters were installed. */
  acquired: {
    listeners: number;
    observers: number;
    timers: number;
    frames: number;
    workers: number;
    idb: number;
    channels: number;
  };
}

/** Installs the counters in the page. Call it once after the page has loaded. */
export async function installCounters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w['__held']) return;
    const rel = {
      listeners: new Map<EventTarget, Map<string, number>>(),
      observers: new Map<object, { name: string; targets: Set<unknown> | null }>(),
      timers: new Map<number, string>(),
      frames: new Set<number>(),
      workers: new Set<object>(),
      idb: new Map<object, string>(),
      channels: new Map<object, string>(),
      acquired: {
        listeners: 0,
        observers: 0,
        timers: 0,
        frames: 0,
        workers: 0,
        idb: 0,
        channels: 0,
      },
    };
    w['__held'] = rel;
    const here = (): string => (new Error().stack ?? '').split('\n').slice(2, 5).join(' < ').trim();

    // Event listeners (not `once` ones, which the page removes by itself when they run).
    const ids = new WeakMap<object, number>();
    let nextId = 1;
    const idOf = (fn: unknown): number => {
      if (fn === null || (typeof fn !== 'object' && typeof fn !== 'function')) return 0;
      const key = fn as object;
      let id = ids.get(key);
      if (id === undefined) ids.set(key, (id = nextId++));
      return id;
    };
    const keyOf = (type: string, listener: unknown, options: unknown): string => {
      const capture =
        typeof options === 'boolean'
          ? options
          : Boolean((options as { capture?: boolean } | undefined)?.capture);
      return `${type}:${String(capture)}:${idOf(listener)}`;
    };
    const proto = EventTarget.prototype;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    proto.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener && !(typeof options === 'object' && options?.once)) {
        let held = rel.listeners.get(this);
        if (!held) rel.listeners.set(this, (held = new Map()));
        const key = keyOf(type, listener, options);
        if (!held.has(key)) {
          held.set(key, 1);
          rel.acquired.listeners++;
        }
      }
      return add.call(this, type, listener, options);
    } as typeof proto.addEventListener;
    proto.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      rel.listeners.get(this)?.delete(keyOf(type, listener, options));
      return remove.call(this, type, listener, options);
    } as typeof proto.removeEventListener;

    // Observers.
    for (const name of [
      'ResizeObserver',
      'MutationObserver',
      'IntersectionObserver',
      'PerformanceObserver',
    ]) {
      const Original = w[name] as (new (...args: never[]) => object) | undefined;
      if (!Original) continue;
      const tracksTargets = name === 'ResizeObserver' || name === 'IntersectionObserver';
      interface Observing {
        observe(...args: unknown[]): unknown;
        unobserve?(...args: unknown[]): unknown;
        disconnect(...args: unknown[]): unknown;
      }
      const Wrapped = class extends (Original as new (...args: never[]) => Observing) {
        override observe(...args: unknown[]): unknown {
          let entry = rel.observers.get(this);
          if (!entry) {
            rel.acquired.observers++;
            rel.observers.set(this, (entry = { name, targets: tracksTargets ? new Set() : null }));
          }
          entry.targets?.add(args[0]);
          return super.observe(...args);
        }
        override unobserve(...args: unknown[]): unknown {
          const entry = rel.observers.get(this);
          entry?.targets?.delete(args[0]);
          if (entry?.targets?.size === 0) rel.observers.delete(this);
          return super.unobserve?.(...args);
        }
        override disconnect(...args: unknown[]): unknown {
          rel.observers.delete(this);
          return super.disconnect(...args);
        }
      };
      w[name] = Wrapped;
    }

    // Timers and frames.
    const st = window.setTimeout.bind(window);
    const ct = window.clearTimeout.bind(window);
    const si = window.setInterval.bind(window);
    const ci = window.clearInterval.bind(window);
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const where = here();
      const id: number = st(
        typeof fn === 'function'
          ? (...a: unknown[]) => {
              rel.timers.delete(id);
              return (fn as (...x: unknown[]) => unknown)(...a);
            }
          : fn,
        ms,
        ...args,
      );
      rel.timers.set(id, `timeout ${String(ms)}ms ${where}`);
      rel.acquired.timers++;
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) rel.timers.delete(id);
      ct(id);
    }) as typeof window.clearTimeout;
    window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id: number = si(fn, ms, ...args);
      rel.timers.set(id, `interval ${String(ms)}ms ${here()}`);
      rel.acquired.timers++;
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) rel.timers.delete(id);
      ci(id);
    }) as typeof window.clearInterval;
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      const id: number = raf((t) => {
        rel.frames.delete(id);
        cb(t);
      });
      rel.frames.add(id);
      rel.acquired.frames++;
      return id;
    };
    window.cancelAnimationFrame = (id: number): void => {
      rel.frames.delete(id);
      caf(id);
    };

    // Workers.
    for (const name of ['Worker', 'SharedWorker']) {
      const Original = w[name] as (new (...args: never[]) => { terminate?(): void }) | undefined;
      if (!Original) continue;
      w[name] = class extends (Original as new (...args: never[]) => { terminate?(): void }) {
        constructor(...args: never[]) {
          super(...args);
          rel.workers.add(this);
          rel.acquired.workers++;
        }
        override terminate(): void {
          rel.workers.delete(this);
          super.terminate?.();
        }
      };
    }

    // IndexedDB: a handle is held from the success of `open` until `close`.
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
      const request =
        version === undefined ? open.call(this, name) : open.call(this, name, version);
      request.addEventListener('success', () => {
        rel.idb.set(request.result, name);
        rel.acquired.idb++;
      });
      return request;
    };
    const close = IDBDatabase.prototype.close;
    IDBDatabase.prototype.close = function (this: IDBDatabase) {
      rel.idb.delete(this);
      close.call(this);
    };

    // Channels: WebSocket and BroadcastChannel.
    for (const name of ['WebSocket', 'BroadcastChannel']) {
      const Original = w[name] as
        (new (...args: never[]) => { close(): void; addEventListener?: unknown }) | undefined;
      if (!Original) continue;
      const Wrapped = class extends (Original as new (...args: never[]) => { close(): void }) {
        constructor(...args: never[]) {
          super(...args);
          rel.channels.set(this, name);
          rel.acquired.channels++;
        }
        override close(...args: unknown[]): void {
          rel.channels.delete(this);
          (super.close as (...a: unknown[]) => void)(...args);
        }
      };
      // The constants (`WebSocket.OPEN`) are inherited from the original class.
      w[name] = Wrapped;
    }
  });
}

/** What the page still holds, as of now. */
export function readCounters(page: Page): Promise<Held> {
  return page.evaluate((): Held => {
    const rel = (window as unknown as Record<string, unknown>)['__held'] as {
      listeners: Map<EventTarget, Map<string, number>>;
      observers: Map<object, { name: string; targets: Set<unknown> | null }>;
      timers: Map<number, string>;
      frames: Set<number>;
      workers: Set<object>;
      idb: Map<object, string>;
      channels: Map<object, string>;
      acquired: Held['acquired'];
    };
    const outlives = (t: EventTarget): string | null => {
      if (t === window) return 'window';
      if (t === document) return 'document';
      if (t === document.documentElement) return 'html';
      if (t === document.body) return 'body';
      if (t instanceof MediaQueryList) return 'mediaQueryList';
      if (window.visualViewport && t === window.visualViewport) return 'visualViewport';
      if (t instanceof Node && t.isConnected && !(t.getRootNode() instanceof ShadowRoot))
        return `element ${(t as Element).localName ?? t.nodeName}`;
      return null;
    };
    const listeners: string[] = [];
    for (const [target, held] of rel.listeners) {
      const kind = outlives(target);
      if (kind === null) continue;
      for (const key of held.keys()) listeners.push(`${kind}:${key.replace(/:\d+$/, '')}`);
    }
    return {
      listeners: listeners.sort(),
      observers: [...rel.observers.values()].map((o) => o.name),
      timers: [...rel.timers.values()],
      frames: rel.frames.size,
      workers: rel.workers.size,
      idb: [...rel.idb.values()],
      channels: [...rel.channels.values()],
      acquired: { ...rel.acquired },
    };
  });
}
