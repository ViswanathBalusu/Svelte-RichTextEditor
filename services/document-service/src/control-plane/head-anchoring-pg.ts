/**
 * The rows of the head anchoring on PostgreSQL (HIS-036; head-anchoring.ts; migration 0098), with
 * the service role: it reads the heads, inserts a record with the heads it covers, and marks a
 * record stored. It cannot change what a record says and cannot delete one. Every transaction sets
 * the tenant, so row-level security limits the work to that tenant's rows.
 */
import type { AnchoredHead } from '@docedit/history';
import { inTenant, type Pool, type Queryable } from '../storage/db.ts';
import type { HeadAnchorStore, StoredHeadAnchor } from './head-anchoring.ts';

interface AnchorRowSql {
  to_ts: Date;
  from_ts: Date | null;
  root: Buffer;
  leaves: number;
  record: string;
  record_sha256: Buffer;
  previous: Buffer | null;
  cms: Buffer;
  timestamp_time: Date;
  key_id: string;
  object_key: string;
  leaves_key: string;
  state: 'signed' | 'stored';
}

const COLUMNS = `to_ts, from_ts, root, leaves, record, record_sha256, previous, cms, timestamp_time,
  key_id, object_key, leaves_key, state`;

const toAnchor = (r: AnchorRowSql): StoredHeadAnchor => ({
  to: r.to_ts.toISOString(),
  from: r.from_ts ? r.from_ts.toISOString() : null,
  root: r.root.toString('hex'),
  leaves: r.leaves,
  record: r.record,
  recordSha256: r.record_sha256.toString('hex'),
  previous: r.previous ? r.previous.toString('hex') : null,
  cms: new Uint8Array(r.cms),
  timestampTime: r.timestamp_time.getTime(),
  keyId: r.key_id,
  objectKey: r.object_key,
  leavesKey: r.leaves_key,
  state: r.state,
});

async function latestOf(c: Queryable, tenant: string): Promise<StoredHeadAnchor | null> {
  const r = await c.query<AnchorRowSql>(
    `SELECT ${COLUMNS} FROM head_anchors WHERE tenant_id = $1 ORDER BY to_ts DESC LIMIT 1`,
    [tenant],
  );
  return r.rows[0] ? toAnchor(r.rows[0]) : null;
}

export class PgHeadAnchorStore implements HeadAnchorStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  changedHeads(tenant: string): Promise<AnchoredHead[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        // One statement, so every head is read at the same moment. A head row changes in the
        // transaction that stores its commit, so `seq` and the chain head always belong together.
        const r = await c.query<{
          doc_id: string;
          incarnation: string;
          head_seq: string;
          chain_head: string;
        }>(
          `SELECT h.doc_id, h.incarnation, h.head_seq, encode(h.chain_head, 'hex') AS chain_head
             FROM doc_heads h
             LEFT JOIN anchored_heads a ON a.doc_id = h.doc_id
            WHERE h.tenant_id = $1 AND h.head_seq > 0 AND h.chain_head IS NOT NULL
              AND (a.doc_id IS NULL OR a.seq <> h.head_seq OR a.incarnation <> h.incarnation
                   OR a.chain_head <> h.chain_head)
            ORDER BY h.doc_id`,
          [tenant],
        );
        return r.rows.map((x) => ({
          doc: x.doc_id,
          incarnation: x.incarnation,
          seq: Number(x.head_seq),
          chainHead: x.chain_head,
        }));
      },
      { readOnly: true },
    );
  }

  latest(tenant: string): Promise<StoredHeadAnchor | null> {
    return inTenant(this.#pool, tenant, (c) => latestOf(c, tenant), { readOnly: true });
  }

  unstored(tenant: string): Promise<StoredHeadAnchor[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<AnchorRowSql>(
          `SELECT ${COLUMNS} FROM head_anchors
            WHERE tenant_id = $1 AND state = 'signed' ORDER BY to_ts`,
          [tenant],
        );
        return r.rows.map(toAnchor);
      },
      { readOnly: true },
    );
  }

  record(
    tenant: string,
    anchor: StoredHeadAnchor,
    heads: readonly AnchoredHead[],
    at: number,
  ): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      // One run at a time records for a tenant; the lock ends with the transaction.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `docedit.head-anchors:${tenant}`,
      ]);
      // The record must follow the tenant's newest one: the line of records has no branch.
      const newest = await latestOf(c, tenant);
      if ((newest?.to ?? null) !== anchor.from) return false;
      if (newest !== null && newest.recordSha256 !== anchor.previous) return false;
      await c.query(
        `INSERT INTO head_anchors
           (tenant_id, to_ts, from_ts, root, leaves, record, record_sha256, previous, cms,
            timestamp_time, key_id, object_key, leaves_key, state, created_at)
         VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, decode($7, 'hex'), decode($8, 'hex'), $9,
                 $10, $11, $12, $13, 'signed', $14)`,
        [
          tenant,
          anchor.to,
          anchor.from,
          anchor.root,
          anchor.leaves,
          anchor.record,
          anchor.recordSha256,
          anchor.previous,
          Buffer.from(anchor.cms),
          new Date(anchor.timestampTime).toISOString(),
          anchor.keyId,
          anchor.objectKey,
          anchor.leavesKey,
          new Date(at).toISOString(),
        ],
      );
      await c.query(
        `INSERT INTO anchored_heads (doc_id, tenant_id, incarnation, seq, chain_head, anchor_to)
         SELECT x.doc, $1, x.incarnation, x.seq, decode(x.chain_head, 'hex'), $2
           FROM unnest($3::uuid[], $4::uuid[], $5::bigint[], $6::text[])
             AS x(doc, incarnation, seq, chain_head)
         ON CONFLICT (doc_id) DO UPDATE
           SET incarnation = excluded.incarnation, seq = excluded.seq,
               chain_head = excluded.chain_head, anchor_to = excluded.anchor_to`,
        [
          tenant,
          anchor.to,
          heads.map((h) => h.doc),
          heads.map((h) => h.incarnation),
          heads.map((h) => h.seq),
          heads.map((h) => h.chainHead),
        ],
      );
      return true;
    });
  }

  markStored(tenant: string, to: string, at: number): Promise<void> {
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `UPDATE head_anchors SET state = 'stored', stored_at = $3
          WHERE tenant_id = $1 AND to_ts = $2 AND state = 'signed'`,
        [tenant, to, new Date(at).toISOString()],
      );
    });
  }
}
