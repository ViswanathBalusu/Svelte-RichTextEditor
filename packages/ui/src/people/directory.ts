/**
 * People through the host's directory (UX-025; 13 §5; 05 §8.1 `resolveUsers`). The document service
 * keeps no profile data, so names and avatars come from the host, and they go nowhere else: this
 * class has no path to the core.
 *
 * - Identifiers asked for in one task are sent in one call, unique, in batches of `batchSize`.
 * - Answers are cached for the session (the directory's lifetime), including "unknown" (null).
 * - Until an answer arrives, or when the host has no `resolveUsers`, a person is shown with the
 *   name the service reported, and failing that with a neutral label. Nothing waits for the host.
 * - A rejected call is retried later, with a growing delay; the fallback stays meanwhile.
 * - Names are plain strings (the shell renders them as text). An avatar address is kept only if it
 *   is `https:`, `http:`, `blob:` or a `data:image/` address; it is only ever an image's `src`.
 */
import type { ReadView, ResolveUsers, UserInfo } from '../core-api.ts';

export interface Person {
  readonly id: string;
  /** The host's name, else the service's, else null (the shell shows its neutral label). */
  readonly name: string | null;
  readonly avatarUrl: string | null;
  /** True once the host answered for this identifier. */
  readonly resolved: boolean;
}

export interface DirectoryOptions {
  resolveUsers?: ResolveUsers;
  /** Largest number of identifiers in one call. */
  batchSize?: number;
  /** Delays before retrying a failed call, in milliseconds; the last one repeats. */
  retryDelaysMs?: readonly number[];
  /** Timers, injectable for tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  /** Reports a failed call (development). */
  onError?: (error: unknown) => void;
}

const DEFAULT_BATCH = 100;
const DEFAULT_RETRIES = [1_000, 5_000, 30_000];

/** The page's base address, for avatar addresses the host gives relative to its own page. */
function pageBase(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.baseURI;
}

/**
 * The avatar address if it is safe to use as an image source, else null. A relative address is
 * resolved against `base` (the host page's address in a browser).
 */
export function safeAvatarUrl(
  value: unknown,
  base: string | undefined = pageBase(),
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'blob:')
    return url.href;
  if (url.protocol === 'data:' && /^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return value;
  return null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 ? name : null;
}

interface Entry {
  info: UserInfo | null;
  resolved: boolean;
}

export class PeopleDirectory {
  readonly #resolve: ResolveUsers | undefined;
  readonly #batchSize: number;
  readonly #retryDelays: readonly number[];
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #cache = new Map<string, Entry>();
  readonly #queued = new Set<string>();
  readonly #inFlight = new Set<string>();
  readonly #failed = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #flushQueued = false;
  #attempt = 0;
  #retryScheduled = false;
  #version = 0;

  /** Changes whenever an answer arrives; read it to re-render. */
  readonly view: ReadView<number>;

  constructor(options: DirectoryOptions = {}) {
    this.#resolve = options.resolveUsers;
    this.#batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
    this.#retryDelays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRIES;
    this.#setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.#onError = options.onError;
    this.view = {
      get: () => this.#version,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  /** The best current answer for an identifier; never waits and never calls the host. */
  lookup(id: string, serviceName?: string | null): Person {
    const entry = this.#cache.get(id);
    const info = entry?.info ?? null;
    return {
      id,
      name: cleanName(info?.name) ?? cleanName(serviceName),
      avatarUrl: safeAvatarUrl(info?.avatarUrl),
      resolved: entry?.resolved ?? false,
    };
  }

  /** Asks the host about identifiers it has not answered yet, in one batch per task. */
  request(ids: Iterable<string>): void {
    if (!this.#resolve) return;
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (this.#cache.get(id)?.resolved || this.#inFlight.has(id) || this.#failed.has(id)) continue;
      this.#queued.add(id);
    }
    if (this.#queued.size === 0 || this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      this.#flush();
    });
  }

  #flush(): void {
    const ids = [...this.#queued];
    this.#queued.clear();
    for (let i = 0; i < ids.length; i += this.#batchSize)
      this.#call(ids.slice(i, i + this.#batchSize));
  }

  #call(ids: string[]): void {
    const resolve = this.#resolve;
    if (!resolve || ids.length === 0) return;
    for (const id of ids) this.#inFlight.add(id);
    let pending: Promise<ReadonlyArray<UserInfo | null>>;
    try {
      pending = Promise.resolve(resolve(ids));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (answers) => {
        for (const id of ids) this.#inFlight.delete(id);
        const list = Array.isArray(answers) ? answers : [];
        ids.forEach((id, i) => {
          // The host's answer is untrusted data: only a name string and an avatar string are kept.
          const raw = (list[i] ?? null) as { name?: unknown; avatarUrl?: unknown } | null;
          const name = raw && typeof raw === 'object' ? cleanName(raw.name) : null;
          const avatar = raw && typeof raw === 'object' ? raw.avatarUrl : undefined;
          const info: UserInfo | null = name
            ? { id, name, ...(typeof avatar === 'string' ? { avatarUrl: avatar } : {}) }
            : null;
          this.#cache.set(id, { info, resolved: true });
        });
        this.#attempt = 0;
        this.#changed();
      },
      (error: unknown) => {
        for (const id of ids) {
          this.#inFlight.delete(id);
          this.#failed.add(id);
        }
        this.#onError?.(error);
        this.#scheduleRetry();
      },
    );
  }

  #scheduleRetry(): void {
    if (this.#retryScheduled) return;
    this.#retryScheduled = true;
    const delays = this.#retryDelays;
    const delay = delays[Math.min(this.#attempt, delays.length - 1)]!;
    this.#attempt++;
    this.#setTimer(() => {
      this.#retryScheduled = false;
      const again = [...this.#failed];
      this.#failed.clear();
      this.request(again);
    }, delay);
  }

  #changed(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}
