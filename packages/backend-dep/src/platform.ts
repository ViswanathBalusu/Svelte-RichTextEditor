/**
 * The platform APIs `backend-dep` uses: the WebSocket client, `fetch` and timers. Browsers and
 * Node.js 22 have all three on `globalThis`, so the package runs in both unchanged. Its TypeScript
 * lib is ES2023 without ambient types (FND-004), so these minimal declarations are the whole
 * surface the code can reach, and tests replace any of them (an in-memory network, virtual time).
 */

/** The events of a WebSocket that `backend-dep` listens to. */
export interface SocketMessageEvent {
  /** A string for a text frame; something else for a binary frame, which `pm-steps/1` never uses. */
  readonly data: unknown;
}

export interface SocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

/** The part of the platform WebSocket client that `backend-dep` uses. */
export interface WebSocketLike {
  /** The subprotocol the server selected; empty until the socket is open. */
  readonly protocol: string;
  /** 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (e: SocketMessageEvent) => void): void;
  addEventListener(type: 'close', listener: (e: SocketCloseEvent) => void): void;
}

export type WebSocketConstructor = new (url: string, protocols: string[]) => WebSocketLike;

/** The part of a `fetch` response that `backend-dep` reads. */
export interface ResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  /** JSON text for the control plane; the bytes of an upload to a pre-signed address (PRO-096). */
  body?: string | Uint8Array;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** A handle returned by `setTimeout`, opaque to the caller. */
export type TimerHandle = unknown;

export interface Platform {
  WebSocket: WebSocketConstructor;
  fetch: FetchLike;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Wall-clock time, Unix milliseconds. Only intervals are derived from it; the server clock decides everything else (01 §8). */
  now(): number;
  /** A number in [0, 1), for the jitter of reconnection delays (05 §4). */
  random(): number;
  /**
   * Calls `cb` when the page is hidden or unloaded (`pagehide`), and returns a function that stops
   * the calls. Absent outside a browser, where there is no page to hide (PRO-019).
   */
  onPageHide?(cb: () => void): () => void;
}

interface PlatformGlobals {
  readonly WebSocket?: WebSocketConstructor;
  readonly fetch?: FetchLike;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** A `pagehide` subscription on the global object, when the environment has one (a browser). */
function pageHideOf(g: PlatformGlobals): Platform['onPageHide'] {
  if (typeof g.addEventListener !== 'function') return undefined;
  return (cb) => {
    const listener = (): void => cb();
    g.addEventListener!('pagehide', listener);
    return () => g.removeEventListener?.('pagehide', listener);
  };
}

/**
 * The platform of the running environment, with `overrides` replacing any part of it. A missing
 * WebSocket or `fetch` is reported when it is first needed, not here, so that a page that only
 * loads the package does not fail.
 */
export function platform(overrides: Partial<Platform> = {}): Platform {
  const g = globalThis as unknown as PlatformGlobals;
  const missing = (what: string) => () => {
    throw new Error(`${what} is not available on this platform; pass one in the platform option`);
  };
  const onPageHide = overrides.onPageHide ?? pageHideOf(g);
  return {
    WebSocket:
      overrides.WebSocket ??
      g.WebSocket ??
      (missing('WebSocket') as unknown as WebSocketConstructor),
    fetch:
      overrides.fetch ??
      (g.fetch ? (url, init) => g.fetch!(url, init) : (missing('fetch') as unknown as FetchLike)),
    setTimeout: overrides.setTimeout ?? ((fn, ms) => g.setTimeout(fn, ms)),
    clearTimeout: overrides.clearTimeout ?? ((h) => g.clearTimeout(h)),
    now: overrides.now ?? (() => Date.now()),
    random: overrides.random ?? (() => Math.random()),
    ...(onPageHide ? { onPageHide } : {}),
  };
}

/**
 * Timers that know which of them are still armed, so that `close()` can cancel every one and a
 * test can check that none remains (PRO-093).
 */
export class Timers {
  private readonly armed = new Map<number, TimerHandle>();
  private counter = 0;
  private readonly p: Platform;

  constructor(p: Platform) {
    this.p = p;
  }

  /** Arms a timer; the returned key cancels it. */
  set(fn: () => void, ms: number): number {
    const key = ++this.counter;
    const handle = this.p.setTimeout(
      () => {
        this.armed.delete(key);
        fn();
      },
      Math.max(0, ms),
    );
    this.armed.set(key, handle);
    return key;
  }

  clear(key: number | null | undefined): void {
    if (key === null || key === undefined) return;
    const handle = this.armed.get(key);
    if (handle === undefined) return;
    this.armed.delete(key);
    this.p.clearTimeout(handle);
  }

  clearAll(): void {
    for (const handle of this.armed.values()) this.p.clearTimeout(handle);
    this.armed.clear();
  }

  /** How many timers are armed. */
  get size(): number {
    return this.armed.size;
  }
}
