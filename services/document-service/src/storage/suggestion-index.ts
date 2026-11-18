/**
 * The suggestion index in PostgreSQL (HIS-042 criterion 4): the commit that introduced each
 * suggestion, by the suggestion's identifier, so that history answers without scanning the log.
 * The table is `suggestion_introductions` (migration 0062), under the tenant's row-level security
 * (BE-011). The lowest `seq` wins, as in `suggestionIndex` of packages/history.
 */
import type { LogCommit } from '@docedit/authority';
import { inTenant, type Pool } from './db.ts';
import { PayloadAbsentError } from './payload-absent.ts';
import type { DocRef, LogStore } from './types.ts';

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

export interface BackfillResult {
  /** Commits whose payload was read. */
  scanned: number;
  /** Suggestion identifiers found and recorded (one already in the index is recorded again, which changes nothing). */
  recorded: number;
  /** Commits whose payload is gone (thinned or replaced by a tombstone), so no claim was read. */
  absent: number;
}

/**
 * Fills the index for a document stored before the index was written as commits were stored (owner
 * decision 86: the index is persisted, with a backfill of what already exists). It reads each
 * commit of the document once, in batches, takes the identifiers it claimed first, and records
 * them; a suggestion keeps the lowest `seq` it was given, so running it again, or over a document
 * that is partly indexed, changes nothing. A commit whose payload was removed (HIS-032, HIS-040)
 * cannot say what it claimed and is counted in `absent`: the index is then as complete as the log.
 * A run is one document; the operator starts it per document, or per tenant by listing them.
 */
export async function backfillSuggestionIntroductions(
  logs: Pick<LogStore, 'head' | 'read'>,
  store: Pick<PgSuggestionIndexStore, 'record'>,
  ref: DocRef,
  batch = 200,
): Promise<BackfillResult> {
  const head = await logs.head(ref);
  const out: BackfillResult = { scanned: 0, recorded: 0, absent: 0 };
  const first = new Map<string, number>();
  const take = (c: LogCommit): void => {
    out.scanned += 1;
    for (const id of c.claimed) if (!first.has(id)) first.set(id, c.seq);
  };
  for (let from = 1; from <= head.seq; from += batch) {
    const to = Math.min(head.seq, from + batch - 1);
    try {
      for (const c of await logs.read(ref, from, to)) take(c);
    } catch (e) {
      if (!(e instanceof PayloadAbsentError)) throw e;
      // Some payload of the batch is gone: read the commits one by one and skip those.
      for (let seq = from; seq <= to; seq++) {
        try {
          for (const c of await logs.read(ref, seq, seq)) take(c);
        } catch (e2) {
          if (!(e2 instanceof PayloadAbsentError)) throw e2;
          out.absent += 1;
        }
      }
    }
  }
  const entries = [...first].map(([suggestionId, seq]) => ({ suggestionId, seq }));
  if (entries.length > 0) await store.record(ref, entries);
  out.recorded = entries.length;
  return out;
}
