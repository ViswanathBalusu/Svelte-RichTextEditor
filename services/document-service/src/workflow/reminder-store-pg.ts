/**
 * The count of raised reminders in PostgreSQL (migration 0076 `workflow_reminders`; FRW-034
 * criterion 5). `claim` is one statement: an insert that, on a conflict with the participant's row,
 * updates it only when the row is the one the caller read (same anchor and count) or belongs to an
 * earlier activation and the caller expects zero. PostgreSQL locks the row for the first of
 * concurrent claims and re-evaluates the condition for the others once it commits, so they see the
 * new count and change nothing. Each statement runs in a transaction of the tenant (BE-011).
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { ReminderStore } from './reminder-store.ts';

export const WORKFLOW_REMINDERS_TABLE = 'workflow_reminders';

export class PgReminderStore implements ReminderStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async raised(
    tenant: string,
    doc: string,
    participant: string,
    anchorMs: number,
  ): Promise<number> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<{ raised: number }>(
          `SELECT raised FROM ${WORKFLOW_REMINDERS_TABLE}
            WHERE tenant_id = $1 AND doc_id = $2 AND participant = $3 AND anchor_ms = $4`,
          [tenant, doc, participant, anchorMs],
        ),
      { readOnly: true },
    );
    return r.rows[0]?.raised ?? 0;
  }

  async claim(
    tenant: string,
    doc: string,
    participant: string,
    anchorMs: number,
    expected: number,
    next: number,
  ): Promise<boolean> {
    if (!(next > expected)) return false;
    const r = await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `INSERT INTO ${WORKFLOW_REMINDERS_TABLE} AS t (tenant_id, doc_id, participant, anchor_ms, raised)
         SELECT $1::uuid, $2::uuid, $3::text, $4::bigint, $6::integer
          WHERE $5::integer = 0 OR EXISTS (
            SELECT 1 FROM ${WORKFLOW_REMINDERS_TABLE}
             WHERE tenant_id = $1 AND doc_id = $2 AND participant = $3
               AND anchor_ms = $4 AND raised = $5)
         ON CONFLICT (tenant_id, doc_id, participant) DO UPDATE
            SET anchor_ms = EXCLUDED.anchor_ms, raised = EXCLUDED.raised
          WHERE (t.anchor_ms = EXCLUDED.anchor_ms AND t.raised = $5)
             OR (t.anchor_ms < EXCLUDED.anchor_ms AND $5 = 0)`,
        [tenant, doc, participant, anchorMs, expected, next],
      ),
    );
    return (r.rowCount ?? 0) === 1;
  }
}
