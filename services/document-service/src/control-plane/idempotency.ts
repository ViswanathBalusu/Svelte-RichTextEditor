/**
 * Idempotency keys (05 §6.1; 06 §4.1 `idempotency_keys`; 10 §3.2; PRO-043, BE-034; decision D140;
 * ADR 0054).
 *
 * A request to a route that accepts `Idempotency-Key` and carries one is remembered under its
 * scope: the tenant, the caller (`user:<surrogate>`, or `service` for any service credential of the
 * tenant), the route (method and concrete path) and the key. With it goes a fingerprint, a SHA-256
 * of the method, the path, the query, the canonical body and the DEP-Actor. The first request
 * claims the scope with a `pending` record before its handler runs; a successful response then
 * completes the record and is kept for the retention time (24 hours by default, a setting). A
 * failed request removes the record, since it created nothing. So:
 *
 * - the same key with the same fingerprint gets the stored response, and nothing runs again;
 * - the same key with another fingerprint is `idempotency_mismatch`;
 * - a second identical request that arrives while the first runs waits for its response, and
 *   gets `conflict` if the first is still running when the wait ends;
 * - another caller, route or tenant has a scope of its own, so a guessed key never reaches
 *   another caller's response or job (10 §3.2);
 * - after the retention time the scope is free again, and the scheduler deletes the record.
 *
 * This module holds the port, the fingerprint and the in-memory store, and loads no database
 * client (BE-002 criterion 1); the store over PostgreSQL is `idempotency-pg.ts`.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@docedit/model';

/** Where a key is remembered. */
export interface IdempotencyScope {
  tenant: string;
  /** `user:<surrogate>` or `service`. */
  principal: string;
  /** Method and concrete path, for example `POST /documents/<id>/exports`. */
  route: string;
  key: string;
}

/** A response as it is replayed: status, the headers that are replayed, the body. */
export interface StoredReply {
  status: number;
  headers: Record<string, string>;
  /** The body bytes, base64; absent for a response without a body. */
  body?: string;
}

export type IdempotencyRecord =
  | { state: 'pending'; fingerprint: string; createdAt: number }
  | { state: 'done'; fingerprint: string; createdAt: number; reply: StoredReply };

export type Claim = { claimed: true } | { claimed: false; record: IdempotencyRecord };

export interface IdempotencyStore {
  /**
   * Claims the scope for a request with `fingerprint`, unless a record that has not expired holds
   * it; then that record is returned. An expired record is replaced, and so is a pending one older
   * than `staleMs`, whose request died before it could finish or release it.
   */
  claim(
    scope: IdempotencyScope,
    fingerprint: string,
    now: number,
    ttlMs: number,
    staleMs: number,
  ): Promise<Claim>;
  /** Stores the response of the request that holds the claim. */
  complete(scope: IdempotencyScope, fingerprint: string, reply: StoredReply): Promise<void>;
  /** Removes the claim of a request that failed, so that a retry runs again. */
  release(scope: IdempotencyScope, fingerprint: string): Promise<void>;
  /** The record that holds the scope now, if it has not expired. */
  read(scope: IdempotencyScope, now: number): Promise<IdempotencyRecord | null>;
  /** Deletes the tenant's records that expired before `now` (BE-052); returns how many. */
  purge(tenant: string, now: number): Promise<number>;
}

/** `Idempotency-Key` values: 1 to 255 visible ASCII characters (D140). */
const KEY = /^[!-~]{1,255}$/;

export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === 'string' && KEY.test(v);
}

/** The fingerprint of a request (D140): what makes two requests with one key the same request. */
export function fingerprintOf(req: {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  actor: string | null;
}): string {
  const query = [...req.query.entries()].sort(([a, x], [b, y]) =>
    a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
  );
  const text = canonicalize({
    method: req.method,
    path: req.path,
    query,
    body: req.body === undefined ? null : req.body,
    actor: req.actor,
  });
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The response headers a replay repeats; everything else is the new request's. */
export const REPLAYED_HEADERS = ['content-type', 'etag', 'location', 'cache-control'];

/** Set on a response that was replayed from the store (D140). */
export const REPLAY_HEADER = 'DEP-Idempotent-Replayed';

// ---------------------------------------------------------------------------------------------

interface MemoryRecord {
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  reply: StoredReply | null;
}

const keyOf = (s: IdempotencyScope) => [s.tenant, s.principal, s.route, s.key].join('\u0000');

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, MemoryRecord>();

  #view(r: MemoryRecord): IdempotencyRecord {
    return r.reply
      ? {
          state: 'done',
          fingerprint: r.fingerprint,
          createdAt: r.createdAt,
          reply: structuredClone(r.reply),
        }
      : { state: 'pending', fingerprint: r.fingerprint, createdAt: r.createdAt };
  }

  async claim(
    scope: IdempotencyScope,
    fingerprint: string,
    now: number,
    ttlMs: number,
    staleMs: number,
  ) {
    const k = keyOf(scope);
    const prior = this.#records.get(k);
    const stale = prior !== undefined && !prior.reply && prior.createdAt + staleMs <= now;
    if (prior && prior.expiresAt > now && !stale)
      return { claimed: false as const, record: this.#view(prior) };
    this.#records.set(k, { fingerprint, createdAt: now, expiresAt: now + ttlMs, reply: null });
    return { claimed: true as const };
  }

  async complete(scope: IdempotencyScope, fingerprint: string, reply: StoredReply): Promise<void> {
    const r = this.#records.get(keyOf(scope));
    if (r && r.fingerprint === fingerprint && !r.reply) r.reply = structuredClone(reply);
  }

  async release(scope: IdempotencyScope, fingerprint: string): Promise<void> {
    const k = keyOf(scope);
    const r = this.#records.get(k);
    if (r && r.fingerprint === fingerprint && !r.reply) this.#records.delete(k);
  }

  async read(scope: IdempotencyScope, now: number): Promise<IdempotencyRecord | null> {
    const r = this.#records.get(keyOf(scope));
    return r && r.expiresAt > now ? this.#view(r) : null;
  }

  async purge(tenant: string, now: number): Promise<number> {
    let n = 0;
    for (const [k, r] of this.#records)
      if (k.startsWith(`${tenant}\u0000`) && r.expiresAt <= now) {
        this.#records.delete(k);
        n++;
      }
    return n;
  }

  /** The number of records kept, for tests. */
  get size(): number {
    return this.#records.size;
  }
}
