/**
 * The suggestion index in PostgreSQL (HIS-042 criterion 4): the commit that introduced each
 * suggestion, by the suggestion's identifier, so that history answers without scanning the log.
 * The table is `suggestion_introductions` (migration 0062), under the tenant's row-level security
 * (BE-011). The lowest `seq` wins, as in `suggestionIndex` of packages/history.
 */
import { inTenant, type Pool } from './db.ts';
import type { DocRef } from './types.ts';

export interface SuggestionIntroductionRow {
  suggestionId: string;
  seq: number;
}

export class PgSuggestionIndexStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Records the introducing commits; a suggestion keeps the lowest `seq` it was ever given. */
  record(ref: DocRef, entries: readonly SuggestionIntroductionRow[]): Promise<void> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      for (const e of entries) {
        await c.query(
          `insert into suggestion_introductions (tenant_id, doc_id, suggestion_id, seq)
           values ($1, $2, $3, $4)
           on conflict (tenant_id, doc_id, suggestion_id) do update
             set seq = least(suggestion_introductions.seq, excluded.seq)`,
          [ref.tenant, ref.doc, e.suggestionId, e.seq],
        );
      }
    });
  }

  /** The `seq` of the commit that introduced the suggestion, or undefined when it is not indexed. */
  introducedBy(ref: DocRef, suggestionId: string): Promise<number | undefined> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<{ seq: string }>(
          'select seq from suggestion_introductions where tenant_id = $1 and doc_id = $2 and suggestion_id = $3',
          [ref.tenant, ref.doc, suggestionId],
        );
        return r.rows[0] === undefined ? undefined : Number(r.rows[0].seq);
      },
      { readOnly: true },
    );
  }
}
