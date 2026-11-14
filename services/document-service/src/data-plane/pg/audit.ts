/**
 * The audit trail in PostgreSQL (migration 0031 `audit_events`; 07 §14; BE-014, PRM-051). Events
 * are inserted and read, never changed: the service role holds no UPDATE or DELETE on the table,
 * and a trigger refuses both for every other role. `insertAuditEvent` writes an event inside a
 * transaction the caller already holds, so that a change and its audit entry commit together
 * (BE-014 criterion 3: the control plane's grant changes use it).
 */
import { inTenant, millis, type Pool, type Queryable } from '../../storage/db.ts';
import type { AuditEvent, AuditQuery, AuditStore } from '../../storage/types.ts';

/** The SQLSTATE PostgreSQL gives an insert for which no partition exists. */
const NO_PARTITION = '23514';

const INSERT = `
  INSERT INTO audit_events (id, tenant_id, doc_id, actor, kind, data, at)
  SELECT x.id, x.tenant_id, x.doc_id, x.actor, x.kind, x.data, x.at
    FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::jsonb[],
                $7::timestamptz[]) AS x(id, tenant_id, doc_id, actor, kind, data, at)`;

function params(events: readonly AuditEvent[]): unknown[] {
  return [
    events.map((e) => e.id),
    events.map((e) => e.tenant),
    events.map((e) => e.doc),
    events.map((e) => e.actor),
    events.map((e) => e.kind),
    events.map((e) => JSON.stringify(e.data)),
    events.map((e) => new Date(e.at).toISOString()),
  ];
}

/**
 * Inserts audit events in the caller's transaction, which must be one of their tenant's (BE-011).
 * Throws when a partition is missing; `PgAuditStore.ensurePartitions` creates them.
 */
export async function insertAuditEvent(
  client: Queryable,
  events: AuditEvent | readonly AuditEvent[],
): Promise<void> {
  const list = Array.isArray(events) ? (events as readonly AuditEvent[]) : [events as AuditEvent];
  if (list.length) await client.query(INSERT, params(list));
}

interface Row {
  id: string;
  tenant_id: string;
  doc_id: string | null;
  actor: string;
  kind: string;
  data: Record<string, unknown>;
  at: Date;
}

export class PgAuditStore implements AuditStore {
  readonly #pool: Pool;
  #ensured = 0;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Creates the partitions of this month and the next `months - 1` that do not exist yet. */
  async ensurePartitions(months = 4): Promise<number> {
    const r = await this.#pool.query<{ n: number }>(
      "SELECT docedit_audit_partitions(now() - interval '1 month', $1) AS n",
      [months + 1],
    );
    this.#ensured = Date.now();
    return r.rows[0]?.n ?? 0;
  }

  async record(events: readonly AuditEvent[]): Promise<void> {
    if (!events.length) return;
    // A day after the last check, make sure the coming months have their partitions.
    if (Date.now() - this.#ensured > 24 * 3600_000) await this.ensurePartitions();
    const byTenant = new Map<string, AuditEvent[]>();
    for (const e of events) {
      const list = byTenant.get(e.tenant) ?? [];
      list.push(e);
      byTenant.set(e.tenant, list);
    }
    for (const [tenant, list] of byTenant) {
      const write = () => inTenant(this.#pool, tenant, (c) => insertAuditEvent(c, list));
      try {
        await write();
      } catch (e) {
        if ((e as { code?: unknown }).code !== NO_PARTITION) throw e;
        await this.ensurePartitions();
        await write();
      }
    }
  }

  query(tenant: string, q: AuditQuery): Promise<AuditEvent[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT id, tenant_id, doc_id, actor, kind, data, at FROM audit_events
            WHERE ($1::uuid IS NULL OR doc_id = $1) AND ($2::text IS NULL OR actor = $2)
              AND ($3::text IS NULL OR kind = $3)
              AND ($4::timestamptz IS NULL OR at >= $4) AND ($5::timestamptz IS NULL OR at < $5)
            ORDER BY at, id LIMIT $6`,
          [
            q.doc ?? null,
            q.actor ?? null,
            q.kind ?? null,
            q.from !== undefined ? new Date(q.from).toISOString() : null,
            q.to !== undefined ? new Date(q.to).toISOString() : null,
            Math.max(1, Math.min(q.limit, 1000)),
          ],
        );
        return r.rows.map((x) => ({
          id: x.id,
          tenant: x.tenant_id,
          doc: x.doc_id,
          actor: x.actor,
          kind: x.kind,
          data: x.data,
          at: millis(x.at)!,
        }));
      },
      { readOnly: true },
    );
  }
}
