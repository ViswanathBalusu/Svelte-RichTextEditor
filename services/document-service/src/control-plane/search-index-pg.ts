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
 * The tables are not yet in a migration in `migrations/`: adding one changes the schema version
 * every database expects, which the main session sequences (the same decision as
 * webhook-deliveries-pg.ts). `SEARCH_INDEX_DDL` is the DDL that migration should carry; it is
 * idempotent, so the lane's test applies it to its own database.
 *
 * Not built here: the `GET /search` route, the purge pipeline that calls `purgeDocument`, and
 * the call that queues an indexing job after a checkpoint is written (BE-054 Notes).
 */
import type { Pool } from 'pg';
import type { JsonNode } from '@docedit/model';
import {
  extractSearchText,
  searchTokens,
  type CheckpointInput,
  type SearchHit,
  type SearchQuery,
} from './search-index.ts';

export const SEARCH_ENTRIES_TABLE = 'search_entries';
export const SEARCH_TOKENS_TABLE = 'search_tokens';

/** The DDL of the two tables and the lookup index. Idempotent. */
export const SEARCH_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS ${SEARCH_ENTRIES_TABLE} (
  tenant     text NOT NULL,
  doc        text NOT NULL,
  visibility text NOT NULL,
  seq        bigint NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (tenant, doc, visibility)
);
CREATE TABLE IF NOT EXISTS ${SEARCH_TOKENS_TABLE} (
  tenant     text NOT NULL,
  doc        text NOT NULL,
  visibility text NOT NULL,
  token      text NOT NULL,
  occurrences integer NOT NULL CHECK (occurrences > 0),
  PRIMARY KEY (tenant, doc, visibility, token),
  FOREIGN KEY (tenant, doc, visibility)
    REFERENCES ${SEARCH_ENTRIES_TABLE} (tenant, doc, visibility) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ${SEARCH_TOKENS_TABLE}_token ON ${SEARCH_TOKENS_TABLE} (tenant, token);
`;

/** The occurrences of each token of a checkpoint's text (as the in-memory index counts them). */
export function tokenCounts(content: JsonNode): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of extractSearchText(content))
    for (const token of searchTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export class PgSearchIndex {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Indexes a checkpoint for one tenant, document and class. Returns whether it was stored (false
   * when a higher sequence is already held for that class). Throws on a database error, so that
   * the job that called it fails and is retried.
   */
  async indexCheckpoint(input: CheckpointInput): Promise<boolean> {
    const counts = tokenCounts(input.content);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const entry = await client.query(
        `INSERT INTO ${SEARCH_ENTRIES_TABLE} (tenant, doc, visibility, seq)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant, doc, visibility)
         DO UPDATE SET seq = EXCLUDED.seq WHERE ${SEARCH_ENTRIES_TABLE}.seq <= EXCLUDED.seq`,
        [input.tenant, input.doc, input.visibility, input.seq],
      );
      if (entry.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `DELETE FROM ${SEARCH_TOKENS_TABLE} WHERE tenant = $1 AND doc = $2 AND visibility = $3`,
        [input.tenant, input.doc, input.visibility],
      );
      if (counts.size > 0) {
        await client.query(
          `INSERT INTO ${SEARCH_TOKENS_TABLE} (tenant, doc, visibility, token, occurrences)
           SELECT $1, $2, $3, u.token, u.occurrences
           FROM unnest($4::text[], $5::integer[]) AS u(token, occurrences)`,
          [input.tenant, input.doc, input.visibility, [...counts.keys()], [...counts.values()]],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Removes every entry of one document of one tenant. Returns how many classes were removed. */
  async purgeDocument(tenant: string, doc: string): Promise<number> {
    const r = await this.#pool.query(
      `DELETE FROM ${SEARCH_ENTRIES_TABLE} WHERE tenant = $1 AND doc = $2`,
      [tenant, doc],
    );
    return r.rowCount ?? 0;
  }

  /** The number of entries held for a tenant (for tests and metrics). */
  async size(tenant: string): Promise<number> {
    const r = await this.#pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SEARCH_ENTRIES_TABLE} WHERE tenant = $1`,
      [tenant],
    );
    return Number(r.rows[0]?.n ?? 0);
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
    const r = await this.#pool.query<{ doc: string; seq: string; score: string }>(
      `WITH matched AS (
         SELECT e.doc, e.visibility, e.seq, sum(t.occurrences) AS score, count(*) AS terms
         FROM ${SEARCH_ENTRIES_TABLE} e
         JOIN ${SEARCH_TOKENS_TABLE} t
           ON t.tenant = e.tenant AND t.doc = e.doc AND t.visibility = e.visibility
         WHERE e.tenant = $1
           AND t.token = ANY($2::text[])
           AND ($3::text[] IS NULL OR e.visibility = ANY($3::text[]))
         GROUP BY e.doc, e.visibility, e.seq
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
    return r.rows.map((row) => ({
      doc: row.doc,
      seq: Number(row.seq),
      score: Number(row.score),
    }));
  }
}
