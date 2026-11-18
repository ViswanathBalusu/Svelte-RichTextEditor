/**
 * The outbox in PostgreSQL (migration 0032; 06 §3, §4.1; BE-039). `enqueue` runs in its own
 * transaction here; the control plane writes an item in the transaction of the state it relied on
 * with `insertOutboxItem` and the same SQL. Claims go through docedit_claim_outbox, across
 * tenants; everything after a claim runs under the item's tenant.
 */
import { uuid7 } from '@docedit/model';
import { inTenant, int, millis, type Pool, type Queryable } from '../../storage/db.ts';
import type {
  AuditEvent,
  NewOutboxItem,
  OutboxItem,
  OutboxStore,
  OutboxWriter,
} from '../../storage/types.ts';
import { insertAuditEvent } from './audit.ts';

interface Row {
  id: string;
  tenant_id: string;
  doc_id: string;
  commit_id: string;
  kind: 'snapshot' | 'author';
  request: Record<string, unknown>;
  payload: Buffer | null;
  state: 'pending' | 'done' | 'failed';
  result: Record<string, unknown> | null;
  attempts: number;
  created_at: Date;
}

function toItem(r: Row): OutboxItem {
  return {
    id: r.id,
    tenant: r.tenant_id,
    doc: r.doc_id,
    commitId: r.commit_id,
    kind: r.kind,
    request: r.request,
    payload: r.payload ? new Uint8Array(r.payload) : null,
    state: r.state,
    result: r.result,
    attempts: int(r.attempts),
    createdAt: millis(r.created_at)!,
  };
}

/**
 * Writes an outbox item in the caller's transaction (under the item's tenant). An item with the
 * same document and commit identifier is kept and returned instead (BE-039 criterion 3).
 */
export async function insertOutboxItem(c: Queryable, item: NewOutboxItem): Promise<OutboxItem> {
  const r = await c.query<Row>(
    `INSERT INTO outbox (id, tenant_id, doc_id, commit_id, kind, request, payload, state,
                         created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', now(), now())
     ON CONFLICT (doc_id, commit_id) DO NOTHING
     RETURNING *`,
    [
      uuid7(),
      item.tenant,
      item.doc,
      item.commitId,
      item.kind,
      JSON.stringify(item.request),
      item.payload ? Buffer.from(item.payload) : null,
    ],
  );
  if (r.rows[0]) return toItem(r.rows[0]);
  const prior = await c.query<Row>('SELECT * FROM outbox WHERE doc_id = $1 AND commit_id = $2', [
    item.doc,
    item.commitId,
  ]);
  return toItem(prior.rows[0]!);
}

export class PgOutbox implements OutboxStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  enqueue(item: NewOutboxItem): Promise<OutboxItem> {
    return inTenant(this.#pool, item.tenant, (c) => insertOutboxItem(c, item));
  }

  get(tenant: string, id: string): Promise<OutboxItem | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>('SELECT * FROM outbox WHERE id = $1', [id]);
        return r.rows[0] ? toItem(r.rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  async claim(node: string, leaseMs: number, limit: number): Promise<OutboxItem[]> {
    const r = await this.#pool.query<Row>('SELECT * FROM docedit_claim_outbox($1, $2, $3)', [
      node,
      Math.max(1, Math.round(leaseMs)),
      Math.max(1, Math.round(limit)),
    ]);
    return r.rows.map(toItem);
  }

  settle(
    item: Pick<OutboxItem, 'tenant' | 'id'>,
    node: string,
    state: 'done' | 'failed',
    result: Record<string, unknown>,
  ): Promise<boolean> {
    return inTenant(this.#pool, item.tenant, async (c) => {
      const r = await c.query(
        `UPDATE outbox SET state = $3, result = $4::jsonb, locked_by = NULL, locked_until = NULL,
                           updated_at = now()
          WHERE id = $1 AND state = 'pending' AND locked_by = $2`,
        [item.id, node, state, JSON.stringify(result)],
      );
      return r.rowCount === 1;
    });
  }

  async unlock(item: Pick<OutboxItem, 'tenant' | 'id'>, node: string): Promise<void> {
    await inTenant(this.#pool, item.tenant, (c) =>
      c.query(
        `UPDATE outbox SET locked_by = NULL, locked_until = NULL, updated_at = now()
          WHERE id = $1 AND state = 'pending' AND locked_by = $2`,
        [item.id, node],
      ),
    );
  }
}

/** The SQLSTATE PostgreSQL gives an insert for which no partition exists (see `pg/audit.ts`). */
const NO_PARTITION = '23514';

/**
 * Outbox items and audit events in one transaction under the tenant (BE-039 criterion 1; 06 §3).
 * When any insert fails the transaction rolls back, so neither an item without its audit event nor
 * an event without its item is left. An item with the same document and commit identifier as one
 * already stored is returned instead, as `PgOutbox.enqueue` does. A missing audit partition is
 * created and the whole unit is tried once more.
 */
export class PgOutboxWriter implements OutboxWriter {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async write(
    tenant: string,
    unit: { items: readonly NewOutboxItem[]; events: readonly AuditEvent[] },
  ): Promise<OutboxItem[]> {
    const once = () =>
      inTenant(this.#pool, tenant, async (c) => {
        await insertAuditEvent(c, unit.events);
        const stored: OutboxItem[] = [];
        for (const item of unit.items) stored.push(await insertOutboxItem(c, item));
        return stored;
      });
    try {
      return await once();
    } catch (e) {
      if ((e as { code?: unknown }).code !== NO_PARTITION) throw e;
      await this.#pool.query(
        "SELECT docedit_audit_partitions(now() - interval '1 month', $1)",
        [5],
      );
      return once();
    }
  }
}
