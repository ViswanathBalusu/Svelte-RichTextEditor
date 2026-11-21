/**
 * The rows of the cold segments on PostgreSQL (HIS-029; cold-segments.ts; migration 0097). The pool
 * must connect as a login that is a member of `docedit_purge` (migration 0073), as for the document
 * purge and the payload thinning: the service role may not delete from `doc_commit_payloads`. Every
 * transaction sets the tenant, so row-level security limits the work to that tenant's rows.
 *
 * `locked` takes a transaction-level advisory lock named after the document. It is held until the
 * transaction ends, so two moves, or a move and a removal, never write the segment objects of one
 * document at the same time, whichever node runs them. A transaction that holds it stays open while
 * its callback talks to object storage; a session that waits too long in a transaction is ended by
 * the server (`idle_in_transaction_session_timeout`), which rolls the transaction back.
 */
import { assertUuid, inTenant, type Pool, type PoolClient } from '../storage/db.ts';
import type {
  ColdCandidateRow,
  ColdFacts,
  ColdSegmentRow,
  ColdSegmentState,
  ColdSegmentStore,
  ColdTx,
} from './cold-segments.ts';

interface SegmentRowSql {
  from_seq: string;
  to_seq: string;
  object_key: string;
  state: ColdSegmentState;
  payloads: number;
}

const toRow = (r: SegmentRowSql): ColdSegmentRow => ({
  fromSeq: Number(r.from_seq),
  toSeq: Number(r.to_seq),
  objectKey: r.object_key,
  state: r.state,
  payloads: r.payloads,
});

const SEGMENT_COLUMNS = 'from_seq, to_seq, object_key, state, payloads';

/** The operations of a lock holder, each one statement on the transaction's connection. */
function txOf(c: PoolClient, tenant: string, doc: string): ColdTx {
  return {
    async row(fromSeq) {
      const r = await c.query<SegmentRowSql>(
        `SELECT ${SEGMENT_COLUMNS} FROM commit_cold_segments
          WHERE tenant_id = $1 AND doc_id = $2 AND from_seq = $3`,
        [tenant, doc, fromSeq],
      );
      return r.rows[0] ? toRow(r.rows[0]) : null;
    },
    async moved(fromSeq, toSeq) {
      const r = await c.query<SegmentRowSql>(
        `SELECT ${SEGMENT_COLUMNS} FROM commit_cold_segments
          WHERE tenant_id = $1 AND doc_id = $2 AND state = 'moved'
            AND to_seq >= $3 AND from_seq <= $4
          ORDER BY from_seq`,
        [tenant, doc, fromSeq, toSeq],
      );
      return r.rows.map(toRow);
    },
    async insertPending(segment, at) {
      // The lock makes the check and the insert one step for every writer of this table.
      const overlap = await c.query(
        `SELECT 1 FROM commit_cold_segments
          WHERE tenant_id = $1 AND doc_id = $2 AND to_seq >= $3 AND from_seq <= $4 LIMIT 1`,
        [tenant, doc, segment.fromSeq, segment.toSeq],
      );
      if ((overlap.rowCount ?? 0) > 0) return false;
      await c.query(
        `INSERT INTO commit_cold_segments
           (doc_id, tenant_id, from_seq, to_seq, object_key, state, payloads, created_at)
         VALUES ($2, $1, $3, $4, $5, 'pending', 0, $6)`,
        [
          tenant,
          doc,
          segment.fromSeq,
          segment.toSeq,
          segment.objectKey,
          new Date(at).toISOString(),
        ],
      );
      return true;
    },
    async payloads(seqs) {
      const out = new Map<number, Uint8Array>();
      if (seqs.length === 0) return out;
      const r = await c.query<{ seq: string; payload: Buffer }>(
        `SELECT seq, payload FROM doc_commit_payloads
          WHERE tenant_id = $1 AND doc_id = $2 AND seq = ANY($3::bigint[])`,
        [tenant, doc, [...seqs]],
      );
      for (const row of r.rows) out.set(Number(row.seq), new Uint8Array(row.payload));
      return out;
    },
    async deletePayloads(seqs) {
      const r = await c.query(
        `DELETE FROM doc_commit_payloads
          WHERE tenant_id = $1 AND doc_id = $2 AND seq = ANY($3::bigint[])`,
        [tenant, doc, [...seqs]],
      );
      // Anything but the full count means another writer took a payload meanwhile: the caller
      // rolls back, and nothing is deleted.
      if (r.rowCount !== seqs.length)
        throw new Error(`${seqs.length} payload rows were to go and ${r.rowCount ?? 0} were there`);
    },
    async setMoved(fromSeq, payloads, at) {
      const r = await c.query(
        `UPDATE commit_cold_segments SET state = 'moved', payloads = $4, moved_at = $5
          WHERE tenant_id = $1 AND doc_id = $2 AND from_seq = $3 AND state = 'pending'`,
        [tenant, doc, fromSeq, payloads, new Date(at).toISOString()],
      );
      if (r.rowCount !== 1) throw new Error('the pending row of the move is gone');
    },
    async setPending(fromSeq) {
      const r = await c.query(
        `UPDATE commit_cold_segments SET state = 'pending', payloads = 0
          WHERE tenant_id = $1 AND doc_id = $2 AND from_seq = $3 AND state = 'moved'`,
        [tenant, doc, fromSeq],
      );
      if (r.rowCount !== 1) throw new Error('the moved row of the segment is gone');
    },
    async setPayloads(fromSeq, payloads) {
      await c.query(
        `UPDATE commit_cold_segments SET payloads = $4
          WHERE tenant_id = $1 AND doc_id = $2 AND from_seq = $3 AND state = 'moved'`,
        [tenant, doc, fromSeq, payloads],
      );
    },
    async deleteRow(fromSeq) {
      await c.query(
        'DELETE FROM commit_cold_segments WHERE tenant_id = $1 AND doc_id = $2 AND from_seq = $3',
        [tenant, doc, fromSeq],
      );
    },
  };
}

export class PgColdSegmentStore implements ColdSegmentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  documents(tenant: string): Promise<string[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ id: string }>(
          'SELECT id FROM documents WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY id',
          [tenant],
        );
        return r.rows.map((x) => x.id);
      },
      { readOnly: true },
    );
  }

  pending(tenant: string): Promise<Array<{ doc: string; fromSeq: number }>> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ doc_id: string; from_seq: string }>(
          `SELECT doc_id, from_seq FROM commit_cold_segments
            WHERE tenant_id = $1 AND state = 'pending' ORDER BY doc_id, from_seq`,
          [tenant],
        );
        return r.rows.map((x) => ({ doc: x.doc_id, fromSeq: Number(x.from_seq) }));
      },
      { readOnly: true },
    );
  }

  facts(tenant: string, doc: string, before: number, limit: number): Promise<ColdFacts> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const cp = await c.query<{ seq: string | null }>(
          `SELECT max(seq) AS seq FROM doc_checkpoints
            WHERE tenant_id = $1 AND doc_id = $2 AND set_aside_at IS NULL AND seq > 0`,
          [tenant, doc],
        );
        const newest = cp.rows[0]?.seq;
        if (newest === null || newest === undefined)
          return { newestCheckpoint: null, candidates: [] };
        // From the payload table, whose key gives the lowest sequence numbers that are still
        // there without walking the commits whose payloads have gone already.
        const rows = await c.query<{ seq: string; server_ts: Date; size: number; hash: string }>(
          `SELECT c.seq, c.server_ts, c.size, encode(c.payload_hash, 'hex') AS hash
             FROM doc_commit_payloads p
             JOIN doc_commits c ON c.doc_id = p.doc_id AND c.seq = p.seq
            WHERE p.tenant_id = $1 AND p.doc_id = $2 AND p.seq <= $3 AND c.server_ts < $4
            ORDER BY p.seq
            LIMIT $5`,
          [tenant, doc, newest, new Date(before).toISOString(), limit],
        );
        return {
          newestCheckpoint: Number(newest),
          candidates: rows.rows.map((x): ColdCandidateRow => ({
            seq: Number(x.seq),
            time: x.server_ts.getTime(),
            payloadHash: x.hash,
            size: x.size,
          })),
        };
      },
      { readOnly: true },
    );
  }

  locked<T>(tenant: string, doc: string, fn: (tx: ColdTx) => Promise<T>): Promise<T> {
    assertUuid(doc, 'document');
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `docedit.cold-segments:${doc}`,
      ]);
      return fn(txOf(c, tenant, doc));
    });
  }
}
