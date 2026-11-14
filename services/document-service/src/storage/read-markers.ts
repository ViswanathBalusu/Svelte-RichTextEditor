/**
 * Read markers (HIS-027 criterion 1; 08 §10; 06 §4.1): the last `seq` a user has seen of a
 * document. One marker per user and document. A marker only moves forward: a lower or equal `seq`
 * leaves it where it is (HIS-027 criterion 2). The PostgreSQL table is `read_markers` (migration
 * 0050), which has a trigger that refuses a backward move as a second guard.
 */
import { inTenant, type Pool } from './db.ts';
import type { DocRef } from './types.ts';

export interface ReadMarkerStore {
  /** The marker of `user` on the document, or undefined when the user has none. */
  get(ref: DocRef, user: string): Promise<number | undefined>;
  /**
   * Moves the marker to `seq` when that is higher, and returns the marker in force afterwards.
   * `user` is the user's surrogate (the caller's actor).
   */
  advance(ref: DocRef, user: string, seq: number, now: number): Promise<number>;
}

/** Read markers in PostgreSQL, under the tenant's row-level security (BE-011). */
export class PgReadMarkerStore implements ReadMarkerStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  get(ref: DocRef, user: string): Promise<number | undefined> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<{ seq: string }>(
          'select seq from read_markers where doc_id = $1 and user_id = $2',
          [ref.doc, user],
        );
        return r.rows[0] === undefined ? undefined : Number(r.rows[0].seq);
      },
      { readOnly: true },
    );
  }

  advance(ref: DocRef, user: string, seq: number, now: number): Promise<number> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      // Only a higher seq writes: the WHERE clause keeps a lower or equal one from moving the row.
      await c.query(
        `insert into read_markers (doc_id, tenant_id, user_id, seq, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (doc_id, user_id) do update
           set seq = excluded.seq, updated_at = excluded.updated_at
           where read_markers.seq < excluded.seq`,
        [ref.doc, ref.tenant, user, seq, new Date(now)],
      );
      const r = await c.query<{ seq: string }>(
        'select seq from read_markers where doc_id = $1 and user_id = $2',
        [ref.doc, user],
      );
      return Number(r.rows[0]!.seq);
    });
  }
}

/** Read markers in memory: nothing outlives the process (the memory parts of the service). */
export class MemoryReadMarkerStore implements ReadMarkerStore {
  readonly #markers = new Map<string, number>();

  static #key(ref: DocRef, user: string): string {
    return JSON.stringify([ref.tenant, ref.doc, user]);
  }

  async get(ref: DocRef, user: string): Promise<number | undefined> {
    return this.#markers.get(MemoryReadMarkerStore.#key(ref, user));
  }

  async advance(ref: DocRef, user: string, seq: number): Promise<number> {
    const key = MemoryReadMarkerStore.#key(ref, user);
    const current = this.#markers.get(key);
    if (current === undefined || current < seq) this.#markers.set(key, seq);
    return this.#markers.get(key)!;
  }
}
