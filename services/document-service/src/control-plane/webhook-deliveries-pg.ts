/**
 * The PostgreSQL delivery store for the webhook dispatcher (05 §7; PRO-071; lane U-PRO-120-131).
 * It implements the `DeliveryStore` interface of webhook-dispatcher.ts over one table, so that a
 * retry keeps its row, its `webhook-id` and its attempt count across a restart of the service.
 *
 * The table is not yet created by a migration in `migrations/`: adding one changes the schema
 * version every database expects, which is a change for the main session to sequence. The DDL
 * below is the one the migration should carry; the lane's test applies it to its own database.
 * Nothing in the running service uses this store yet, so the dispatcher's in-memory store remains
 * the only one composed.
 *
 * Times are Unix milliseconds, kept as BIGINT. The body is kept as text exactly as sent, because
 * a replay sends it again and a signature covers it.
 */
import type { Pool } from 'pg';
import type { DeliveryRow, DeliveryStore } from './webhook-dispatcher.ts';

export const WEBHOOK_DELIVERIES_TABLE = 'webhook_deliveries';

/** The DDL of the table and its index. Idempotent, so that a test may apply it to a fresh database. */
export const WEBHOOK_DELIVERIES_DDL = `
CREATE TABLE IF NOT EXISTS ${WEBHOOK_DELIVERIES_TABLE} (
  id           text PRIMARY KEY,
  message_id   text NOT NULL,
  tenant       text NOT NULL,
  subscription text NOT NULL,
  event_type   text NOT NULL,
  event_id     text NOT NULL,
  body         text NOT NULL,
  is_test      boolean NOT NULL,
  state        text NOT NULL CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts     integer NOT NULL CHECK (attempts >= 0),
  last_status  integer,
  last_reason  text,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ${WEBHOOK_DELIVERIES_TABLE}_subscription
  ON ${WEBHOOK_DELIVERIES_TABLE} (tenant, subscription, created_at, id);
`;

const COLUMNS =
  'id, message_id, tenant, subscription, event_type, event_id, body, is_test, state, attempts, last_status, last_reason, created_at, updated_at';

interface Stored {
  id: string;
  message_id: string;
  tenant: string;
  subscription: string;
  event_type: string;
  event_id: string;
  body: string;
  is_test: boolean;
  state: DeliveryRow['state'];
  attempts: number;
  last_status: number | null;
  last_reason: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function fromStored(r: Stored): DeliveryRow {
  return {
    id: r.id,
    messageId: r.message_id,
    tenant: r.tenant,
    subscription: r.subscription,
    eventType: r.event_type,
    eventId: r.event_id,
    body: r.body,
    test: r.is_test,
    state: r.state,
    attempts: r.attempts,
    lastStatus: r.last_status,
    lastReason: r.last_reason,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class PgDeliveryStore implements DeliveryStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async insert(row: DeliveryRow): Promise<void> {
    // A repeated identifier is a primary-key violation: the caller gets the database error.
    await this.#pool.query(
      `INSERT INTO ${WEBHOOK_DELIVERIES_TABLE} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        row.id,
        row.messageId,
        row.tenant,
        row.subscription,
        row.eventType,
        row.eventId,
        row.body,
        row.test,
        row.state,
        row.attempts,
        row.lastStatus,
        row.lastReason,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<DeliveryRow | null> {
    const r = await this.#pool.query<Stored>(
      `SELECT ${COLUMNS} FROM ${WEBHOOK_DELIVERIES_TABLE} WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? null : fromStored(row);
  }

  async update(row: DeliveryRow): Promise<void> {
    const r = await this.#pool.query(
      `UPDATE ${WEBHOOK_DELIVERIES_TABLE} SET message_id = $2, tenant = $3, subscription = $4,
         event_type = $5, event_id = $6, body = $7, is_test = $8, state = $9, attempts = $10,
         last_status = $11, last_reason = $12, created_at = $13, updated_at = $14
       WHERE id = $1`,
      [
        row.id,
        row.messageId,
        row.tenant,
        row.subscription,
        row.eventType,
        row.eventId,
        row.body,
        row.test,
        row.state,
        row.attempts,
        row.lastStatus,
        row.lastReason,
        row.createdAt,
        row.updatedAt,
      ],
    );
    if (r.rowCount === 0) throw new Error('no such delivery');
  }

  async ofSubscription(tenant: string, subscription: string): Promise<DeliveryRow[]> {
    const r = await this.#pool.query<Stored>(
      `SELECT ${COLUMNS} FROM ${WEBHOOK_DELIVERIES_TABLE}
        WHERE tenant = $1 AND subscription = $2
        ORDER BY created_at, id`,
      [tenant, subscription],
    );
    return r.rows.map(fromStored);
  }
}
