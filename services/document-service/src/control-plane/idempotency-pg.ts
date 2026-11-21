/**
 * The idempotency records in PostgreSQL (migration 0040; 06 §4.1 `idempotency_keys`), under the
 * tenant's row-level security. The port, its record types, the fingerprint and the in-memory
 * store are in `idempotency.ts`; this adapter is in a file of its own so that the request
 * pipeline, which imports that module, loads no database client (BE-002 criterion 1).
 */
import { inTenant, int, millis, type Pool } from '../storage/db.ts';
import type {
  Claim,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
  StoredReply,
} from './idempotency.ts';

interface Row {
  body_hash: Buffer;
  state: 'pending' | 'done';
  status: number | null;
  response: { headers: Record<string, string>; body?: string } | null;
  created_at: Date;
}

function toRecord(r: Row): IdempotencyRecord {
  const fingerprint = r.body_hash.toString('hex');
  const createdAt = millis(r.created_at)!;
  if (r.state === 'pending' || r.status === null)
    return { state: 'pending', fingerprint, createdAt };
  return {
    state: 'done',
    fingerprint,
    createdAt,
    reply: {
      status: int(r.status),
      headers: r.response?.headers ?? {},
      ...(r.response?.body !== undefined ? { body: r.response.body } : {}),
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The records in PostgreSQL (migration 0040), under the tenant's row-level security. Times are
 * the service clock's, so that the retention follows the same clock as the rest of the request
 * (and the shortened timers of test mode, BE-079).
 */
export class PgIdempotencyStore implements IdempotencyStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  claim(
    scope: IdempotencyScope,
    fingerprint: string,
    now: number,
    ttlMs: number,
    staleMs: number,
  ): Promise<Claim> {
    return inTenant(this.#pool, scope.tenant, async (c) => {
      // Two claims at once: the unique key orders them; the second sees the first's row.
      const ins = await c.query(
        `INSERT INTO idempotency_keys (tenant_id, principal, route, key, body_hash, state,
                                       created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         ON CONFLICT (tenant_id, principal, route, key) DO UPDATE
            SET body_hash = excluded.body_hash, state = 'pending', status = NULL,
                response = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at
          WHERE idempotency_keys.expires_at <= $6
             OR (idempotency_keys.state = 'pending' AND idempotency_keys.created_at <= $8)`,
        [
          scope.tenant,
          scope.principal,
          scope.route,
          scope.key,
          Buffer.from(fingerprint, 'hex'),
          iso(now),
          iso(now + ttlMs),
          iso(now - staleMs),
        ],
      );
      if (ins.rowCount === 1) return { claimed: true as const };
      const r = await c.query<Row>(
        `SELECT body_hash, state, status, response, created_at FROM idempotency_keys
          WHERE tenant_id = $1 AND principal = $2 AND route = $3 AND key = $4`,
        [scope.tenant, scope.principal, scope.route, scope.key],
      );
      const row = r.rows[0];
      if (!row) throw new Error('the idempotency record vanished while it was read');
      return { claimed: false as const, record: toRecord(row) };
    });
  }

  complete(scope: IdempotencyScope, fingerprint: string, reply: StoredReply): Promise<void> {
    return inTenant(this.#pool, scope.tenant, async (c) => {
      await c.query(
        `UPDATE idempotency_keys SET state = 'done', status = $6, response = $7::jsonb
          WHERE tenant_id = $1 AND principal = $2 AND route = $3 AND key = $4
            AND body_hash = $5 AND state = 'pending'`,
        [
          scope.tenant,
          scope.principal,
          scope.route,
          scope.key,
          Buffer.from(fingerprint, 'hex'),
          reply.status,
          JSON.stringify({
            headers: reply.headers,
            ...(reply.body !== undefined ? { body: reply.body } : {}),
          }),
        ],
      );
    });
  }

  release(scope: IdempotencyScope, fingerprint: string): Promise<void> {
    return inTenant(this.#pool, scope.tenant, async (c) => {
      await c.query(
        `DELETE FROM idempotency_keys
          WHERE tenant_id = $1 AND principal = $2 AND route = $3 AND key = $4
            AND body_hash = $5 AND state = 'pending'`,
        [scope.tenant, scope.principal, scope.route, scope.key, Buffer.from(fingerprint, 'hex')],
      );
    });
  }

  read(scope: IdempotencyScope, now: number): Promise<IdempotencyRecord | null> {
    return inTenant(
      this.#pool,
      scope.tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT body_hash, state, status, response, created_at FROM idempotency_keys
            WHERE tenant_id = $1 AND principal = $2 AND route = $3 AND key = $4
              AND expires_at > $5`,
          [scope.tenant, scope.principal, scope.route, scope.key, iso(now)],
        );
        return r.rows[0] ? toRecord(r.rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  purge(tenant: string, now: number): Promise<number> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND expires_at <= $2',
        [tenant, iso(now)],
      );
      return r.rowCount ?? 0;
    });
  }
}
