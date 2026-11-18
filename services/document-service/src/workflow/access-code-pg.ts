/**
 * The registered access codes in PostgreSQL (migration 0077 `workflow_access_codes`; FRW-039). The
 * table holds the salt and the hash of each code and the counter of wrong attempts, never a code.
 * `reserve` is one UPDATE that moves the counter and returns the record in the same statement, so
 * of any number of concurrent attempts each is counted and at most `maxAttempts` per window pass.
 * Each statement runs in a transaction of the tenant (BE-011).
 */
import type { AccessCodeRecord } from '@docedit/authority';
import { inTenant, type Pool } from '../storage/db.ts';
import type { AccessCodeStore, AttemptPolicy, Reservation } from './access-code-store.ts';

export const WORKFLOW_ACCESS_CODES_TABLE = 'workflow_access_codes';

export class PgAccessCodeStore implements AccessCodeStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async register(
    tenant: string,
    doc: string,
    participant: string,
    record: AccessCodeRecord,
    atMs: number,
  ): Promise<void> {
    await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `INSERT INTO ${WORKFLOW_ACCESS_CODES_TABLE}
           (tenant_id, doc_id, participant, salt, hash, failures, window_start_ms, registered_at_ms)
         VALUES ($1, $2, $3, $4, $5, 0, NULL, $6)
         ON CONFLICT (tenant_id, doc_id, participant) DO UPDATE
            SET salt = EXCLUDED.salt, hash = EXCLUDED.hash, failures = 0,
                window_start_ms = NULL, registered_at_ms = EXCLUDED.registered_at_ms`,
        [tenant, doc, participant, record.salt, record.hash, atMs],
      ),
    );
  }

  async reserve(
    tenant: string,
    doc: string,
    participant: string,
    atMs: number,
    policy: AttemptPolicy,
  ): Promise<Reservation> {
    const r = await inTenant(this.#pool, tenant, (c) =>
      c.query<{ salt: string; hash: string; failures: number; window_start_ms: string }>(
        `UPDATE ${WORKFLOW_ACCESS_CODES_TABLE} SET
            failures = CASE WHEN window_start_ms IS NULL OR $4::bigint >= window_start_ms + $5::bigint
                            THEN 1 ELSE failures + 1 END,
            window_start_ms = CASE WHEN window_start_ms IS NULL OR $4::bigint >= window_start_ms + $5::bigint
                                   THEN $4::bigint ELSE window_start_ms END
          WHERE tenant_id = $1 AND doc_id = $2 AND participant = $3
          RETURNING salt, hash, failures, window_start_ms::text AS window_start_ms`,
        [tenant, doc, participant, atMs, policy.windowMs],
      ),
    );
    const row = r.rows[0];
    if (row === undefined) return { state: 'none' };
    if (row.failures > policy.maxAttempts)
      return {
        state: 'limited',
        retryAfterMs: Math.max(1, Number(row.window_start_ms) + policy.windowMs - atMs),
      };
    return { state: 'open', record: { method: 'access_code', salt: row.salt, hash: row.hash } };
  }

  async clear(tenant: string, doc: string, participant: string): Promise<void> {
    await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `UPDATE ${WORKFLOW_ACCESS_CODES_TABLE} SET failures = 0, window_start_ms = NULL
          WHERE tenant_id = $1 AND doc_id = $2 AND participant = $3`,
        [tenant, doc, participant],
      ),
    );
  }
}
