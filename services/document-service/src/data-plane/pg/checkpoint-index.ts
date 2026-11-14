/**
 * The checkpoint index in PostgreSQL (migration 0030 `doc_checkpoints`; 06 §4.1; BE-020, BE-078).
 * Every query runs under the document's tenant (row-level security; BE-011), except the operator's
 * scan for documents whose checkpoints reach past their head, which runs as the schema owner.
 */
import { inTenant, int, millis, type Pool } from '../../storage/db.ts';
import type { CheckpointIndex, CheckpointRow, DocRef } from '../../storage/types.ts';

interface Row {
  seq: string;
  object_key: string;
  bytes: number;
  content_hash: Buffer;
  created_at: Date;
}

export class PgCheckpointIndex implements CheckpointIndex {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  record(ref: DocRef, row: Omit<CheckpointRow, 'createdAt'>): Promise<void> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      await c.query(
        `INSERT INTO doc_checkpoints (doc_id, seq, tenant_id, object_key, bytes, content_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (doc_id, seq) DO UPDATE
           SET object_key = excluded.object_key, bytes = excluded.bytes,
               content_hash = excluded.content_hash, created_at = excluded.created_at,
               set_aside_at = NULL`,
        [ref.doc, row.seq, ref.tenant, row.key, row.bytes, Buffer.from(row.hash, 'hex')],
      );
    });
  }

  list(ref: DocRef): Promise<CheckpointRow[]> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT seq, object_key, bytes, content_hash, created_at FROM doc_checkpoints
            WHERE doc_id = $1 AND set_aside_at IS NULL ORDER BY seq`,
          [ref.doc],
        );
        return r.rows.map((x) => ({
          seq: int(x.seq),
          key: x.object_key,
          bytes: x.bytes,
          hash: x.content_hash.toString('hex'),
          createdAt: millis(x.created_at)!,
        }));
      },
      { readOnly: true },
    );
  }

  setAside(ref: DocRef, aboveSeq: number): Promise<number[]> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      const r = await c.query<{ seq: string }>(
        `UPDATE doc_checkpoints SET set_aside_at = now()
          WHERE doc_id = $1 AND seq > $2 AND set_aside_at IS NULL RETURNING seq`,
        [ref.doc, aboveSeq],
      );
      return r.rows.map((x) => int(x.seq)).sort((a, b) => a - b);
    });
  }
}
