/**
 * Version-pinned content and assets cached near the reader (BE-075; 06 §7; 10 §3.7; ADR 0019
 * SR-C4). A reader far from the home region may be served a copy of an immutable resource from a
 * cache near them. The rules this module holds:
 *
 * - Only immutable resources are cached: content pinned to a `seq` and assets addressed by their
 *   hash. A mutable read (the head, "latest") has no key here and is refused by `pinnedKey`.
 * - A cache key carries the tenant, the resource and the reader's visibility class (ADR 0019): the
 *   same bytes can differ by class, and a copy made for one class is never served to another.
 * - The permission check and the visibility gate run before any copy is served, on every request,
 *   hit or miss. A copy is a cache of bytes the home region would serve, not a grant.
 * - A document with hidden scopes is not cached at all, neither stored nor read (SR-C4).
 * - A tenant that switches caching off gets every read from the home region, nothing is stored
 *   near the reader, and whatever was stored for it is dropped.
 *
 * The composition supplies the switch, the check and the home fetch. The cache holds bytes and
 * nothing else: it has no knowledge of commits, grants or ownership.
 */
import type { DocRef } from '../storage/types.ts';

const HASH = /^[0-9a-f]{64}$/;

/** A resource that may be cached: pinned to a sequence number, or content-addressed. */
export type PinnedResource =
  | {
      readonly kind: 'content';
      readonly doc: DocRef;
      readonly seq: number;
      /**
       * The log incarnation the `seq` belongs to. A rewound log reuses sequence numbers under a new
       * incarnation, so a copy is immutable only for the pair; the content route always passes it.
       */
      readonly incarnation?: string;
    }
  | { readonly kind: 'asset'; readonly tenant: string; readonly hash: string };

export interface PinnedRequest {
  readonly resource: PinnedResource;
  /** The reader's visibility class, as ADR 0019 names it (for example the view token). */
  readonly visibilityClass: string;
  /** The document has hidden scopes, so it is never cached at a shared edge (SR-C4). */
  readonly restricted: boolean;
  /** The principal the permission check applies to. */
  readonly reader: string;
}

/** Thrown for a resource that is not immutable, or a key that is malformed. */
export class NotCacheable extends RangeError {
  override name = 'NotCacheable';
}

/** The tenant a resource belongs to. */
export function tenantOf(resource: PinnedResource): string {
  return resource.kind === 'content' ? resource.doc.tenant : resource.tenant;
}

/**
 * The cache key of a request. Built from a JSON array so that no separator inside a value can make
 * two different requests share a key. Throws `NotCacheable` for a mutable or malformed resource.
 */
export function pinnedKey(req: PinnedRequest): string {
  if (typeof req.visibilityClass !== 'string' || req.visibilityClass.length === 0)
    throw new NotCacheable('a cache key needs a visibility class');
  const r = req.resource;
  if (r.kind === 'content') {
    if (!Number.isSafeInteger(r.seq) || r.seq < 0)
      throw new NotCacheable('content is cacheable only when pinned to a sequence number');
    if (r.doc.tenant.length === 0 || r.doc.doc.length === 0)
      throw new NotCacheable('a cache key needs the tenant and the document');
    if (r.incarnation !== undefined)
      return JSON.stringify([
        'v1',
        r.doc.tenant,
        'content',
        r.doc.doc,
        r.incarnation,
        r.seq,
        req.visibilityClass,
      ]);
    return JSON.stringify(['v1', r.doc.tenant, 'content', r.doc.doc, r.seq, req.visibilityClass]);
  }
  if (r.kind === 'asset') {
    if (!HASH.test(r.hash)) throw new NotCacheable('assets are cacheable only by content hash');
    if (r.tenant.length === 0) throw new NotCacheable('a cache key needs the tenant');
    return JSON.stringify(['v1', r.tenant, 'asset', r.hash, req.visibilityClass]);
  }
  throw new NotCacheable('the resource is not one that can be cached');
}

export type ServeOutcome =
  | { readonly status: 'served'; readonly body: Uint8Array; readonly from: 'cache' | 'home' }
  | { readonly status: 'refused' }
  | { readonly status: 'not-found' };

/** What the cache asks of the caller for one request. */
export interface PinnedCalls {
  /**
   * The permission check and the visibility gate for the request. False refuses it; a thrown
   * error refuses it too and reaches the caller. Called on every request, before any copy is served.
   * It may return the request made exact by what the check read (for example the log incarnation
   * of pinned content); the copy is then keyed by that request, which must be of the same tenant.
   */
  authorise(req: PinnedRequest): Promise<boolean | PinnedRequest>;
  /** Reads the resource from the home region; null when it does not exist. */
  fromHome(req: PinnedRequest): Promise<Uint8Array | null>;
}

export interface PinnedCacheOptions extends Partial<PinnedCalls> {
  /** Whether the tenant allows caching near readers (BE-075 criterion 4). */
  cachingEnabled(tenant: string): boolean;
  /**
   * Copies held at most, over all tenants (a setting). Beyond it, copies are dropped oldest first,
   * starting with the tenant that stored first. Absent: no limit.
   */
  maxEntries?: number;
}

export interface PinnedCacheStats {
  hits: number;
  misses: number;
  homeReads: number;
  refused: number;
  stored: number;
}

export class PinnedCache {
  readonly #o: PinnedCacheOptions;
  /** Entries by tenant, then by key, so that a tenant's copies can be dropped as a whole. */
  readonly #byTenant = new Map<string, Map<string, Uint8Array>>();
  readonly stats: PinnedCacheStats = { hits: 0, misses: 0, homeReads: 0, refused: 0, stored: 0 };

  constructor(options: PinnedCacheOptions) {
    this.#o = options;
  }

  /** The number of copies held for a tenant (for tests and metrics). */
  entries(tenant: string): number {
    return this.#byTenant.get(tenant)?.size ?? 0;
  }

  /** Drops every copy held for a tenant. */
  purge(tenant: string): void {
    this.#byTenant.delete(tenant);
  }

  /**
   * Serves one request. `calls` are the request's own check and home read (a route passes them per
   * request); without them, those given to the constructor are used.
   */
  async serve(asked: PinnedRequest, calls: Partial<PinnedCalls> = {}): Promise<ServeOutcome> {
    const authorise = calls.authorise ?? this.#o.authorise;
    const fromHome = calls.fromHome ?? this.#o.fromHome;
    if (!authorise || !fromHome) throw new TypeError('a pinned read needs a check and a home read');
    const tenant = tenantOf(asked.resource);
    // The key is built first: a mutable resource is refused before anything is read.
    let key = pinnedKey(asked);
    let req = asked;
    // The check runs before any copy is served, and before the home region is asked.
    let allowed: boolean | PinnedRequest;
    try {
      allowed = await authorise(asked);
    } catch (e) {
      this.stats.refused++;
      throw e;
    }
    if (allowed === false) {
      this.stats.refused++;
      return { status: 'refused' };
    }
    if (allowed !== true) {
      if (tenantOf(allowed.resource) !== tenant)
        throw new NotCacheable('a check may not move a request to another tenant');
      req = allowed;
      key = pinnedKey(req);
    }
    if (!this.#o.cachingEnabled(tenant)) {
      this.purge(tenant);
      return this.#home(req, fromHome);
    }
    if (req.restricted) return this.#home(req, fromHome);

    const held = this.#byTenant.get(tenant)?.get(key);
    if (held) {
      this.stats.hits++;
      return { status: 'served', body: held, from: 'cache' };
    }
    this.stats.misses++;
    const home = await fromHome(req);
    this.stats.homeReads++;
    if (!home) return { status: 'not-found' };
    let map = this.#byTenant.get(tenant);
    if (!map) this.#byTenant.set(tenant, (map = new Map()));
    map.set(key, home);
    this.stats.stored++;
    this.#evict();
    return { status: 'served', body: home, from: 'home' };
  }

  /** Drops the oldest copies while more than `maxEntries` are held. */
  #evict(): void {
    const max = this.#o.maxEntries;
    if (max === undefined) return;
    let held = 0;
    for (const m of this.#byTenant.values()) held += m.size;
    // Tenants iterate in the order they were first stored, and keys within a tenant likewise.
    for (const [tenant, m] of this.#byTenant) {
      for (const key of m.keys()) {
        if (held <= max) return;
        m.delete(key);
        held--;
      }
      if (m.size === 0) this.#byTenant.delete(tenant);
    }
  }

  async #home(req: PinnedRequest, fromHome: PinnedCalls['fromHome']): Promise<ServeOutcome> {
    this.stats.homeReads++;
    const body = await fromHome(req);
    return body ? { status: 'served', body, from: 'home' } : { status: 'not-found' };
  }
}
