/**
 * The PostgreSQL search index (06 §1 indexer; 05 §6.2 `/search`; BE-054 criteria 1 and 3; lane
 * U-BE-043-056). It holds the same entries as the in-memory `SearchIndex` of search-index.ts, one
 * entry per tenant, document and visibility class, and answers the same queries with the same
 * ranking, so that the indexer job of search-indexer.ts can write to either.
 *
 * The rules it keeps:
 *
 * - Every key includes the tenant: the primary keys, the joins and every filter name it.
 * - A checkpoint with a lower sequence than the one held for its class does not replace it. The
 *   check and the write are one statement (`ON CONFLICT ... WHERE`), so two indexers racing on one
 *   class keep the higher sequence.
 * - Each entry's tokens are replaced in the same transaction as the entry, so a search never sees
 *   the tokens of one checkpoint with the sequence of another.
 * - Purging a document removes its entries and their tokens (`ON DELETE CASCADE`).
 *
 * The tables are in migration 0086 (BE-054 criterion 1). They carry `tenant_id`, forced row-level
 * security and the tenant policy (BE-011), so every statement here runs inside `inTenant`: the
 * pool is the service role's, and a statement outside a tenant's transaction sees no row.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import {
  tokenCounts,
  searchTokens,
  type CheckpointInput,
  type SearchHit,
  type SearchQuery,
} from './search-index.ts';

export const SEARCH_ENTRIES_TABLE = 'search_entries';
export const SEARCH_TOKENS_TABLE = 'search_tokens';

export { tokenCounts };

export class PgSearchIndex {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Indexes a checkpoint for one tenant, document and class. Returns whether it was stored (false
   * when a higher sequence is already held for that class). Throws on a database error, so that
   * the job that called it fails and is retried. `input.tokens`, when given, is the count the
   * caller made off the event loop (a worker thread); otherwise it is made here.
   */
  async indexCheckpoint(input: CheckpointInput): Promise<boolean> {
    const counts = input.tokens ?? tokenCounts(input.content);
    return inTenant(this.#pool, input.tenant, async (client) => {
      const entry = await client.query(
        `INSERT INTO ${SEARCH_ENTRIES_TABLE} (tenant_id, doc_id, visibility, seq)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, doc_id, visibility)
         DO UPDATE SET seq = EXCLUDED.seq WHERE ${SEARCH_ENTRIES_TABLE}.seq <= EXCLUDED.seq`,
        [input.tenant, input.doc, input.visibility, input.seq],
      );
      if (entry.rowCount === 0) return false;
      await client.query(
        `DELETE FROM ${SEARCH_TOKENS_TABLE}
          WHERE tenant_id = $1 AND doc_id = $2 AND visibility = $3`,
        [input.tenant, input.doc, input.visibility],
      );
      if (counts.size > 0) {
        await client.query(
          `INSERT INTO ${SEARCH_TOKENS_TABLE} (tenant_id, doc_id, visibility, token, occurrences)
           SELECT $1, $2, $3, u.token, u.occurrences
           FROM unnest($4::text[], $5::integer[]) AS u(token, occurrences)`,
          [input.tenant, input.doc, input.visibility, [...counts.keys()], [...counts.values()]],
        );
      }
      return true;
    });
  }

  /** Removes every entry of one document of one tenant. Returns how many classes were removed. */
  async purgeDocument(tenant: string, doc: string): Promise<number> {
    return inTenant(this.#pool, tenant, async (client) => {
      const r = await client.query(
        `DELETE FROM ${SEARCH_ENTRIES_TABLE} WHERE tenant_id = $1 AND doc_id = $2`,
        [tenant, doc],
      );
      return r.rowCount ?? 0;
    });
  }

  /** The number of entries held for a tenant (for tests and metrics). */
  async size(tenant: string): Promise<number> {
    return inTenant(
      this.#pool,
      tenant,
      async (client) => {
        const r = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${SEARCH_ENTRIES_TABLE} WHERE tenant_id = $1`,
          [tenant],
        );
        return Number(r.rows[0]?.n ?? 0);
      },
      { readOnly: true },
    );
  }

  /**
   * Searches one tenant's readable entries with the same rules as `SearchIndex.search`: every
   * term is required, the score is the sum of occurrences, one hit per document (its best
   * readable entry), ordered by score and then by document identifier.
   */
  async search(tenant: string, q: string, query: SearchQuery): Promise<SearchHit[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1)
      throw new RangeError('search limit must be a positive integer');
    const terms = [...new Set(searchTokens(q))];
    if (terms.length === 0) return [];
    const classes = query.readable === 'all' ? null : [...query.readable];
    const rows = await inTenant(
      this.#pool,
      tenant,
      async (client) => {
        const r = await client.query<{ doc: string; seq: string; score: string }>(
          `WITH matched AS (
             SELECT e.doc_id::text AS doc, e.visibility, e.seq, sum(t.occurrences) AS score,
                    count(*) AS terms
             FROM ${SEARCH_ENTRIES_TABLE} e
             JOIN ${SEARCH_TOKENS_TABLE} t
               ON t.tenant_id = e.tenant_id AND t.doc_id = e.doc_id AND t.visibility = e.visibility
             WHERE e.tenant_id = $1
               AND t.token = ANY($2::text[])
               AND ($3::text[] IS NULL OR e.visibility = ANY($3::text[]))
             GROUP BY e.doc_id, e.visibility, e.seq
             HAVING count(*) = $4
           ),
           best AS (
             SELECT DISTINCT ON (doc COLLATE "C") doc, seq, score
             FROM matched
             ORDER BY doc COLLATE "C", score DESC, seq DESC
           )
           SELECT doc, seq::text AS seq, score::text AS score
           FROM best
           WHERE $6::numeric IS NULL
              OR score < $6::numeric
              OR (score = $6::numeric AND doc COLLATE "C" > $7::text COLLATE "C")
           ORDER BY score DESC, doc COLLATE "C" ASC
           LIMIT $5`,
          [
            tenant,
            terms,
            classes,
            terms.length,
            query.limit,
            query.after?.score ?? null,
            query.after?.doc ?? null,
          ],
        );
        return r.rows;
      },
      { readOnly: true },
    );
    return rows.map((row) => ({
      doc: row.doc,
      seq: Number(row.seq),
      score: Number(row.score),
    }));
  }
}
