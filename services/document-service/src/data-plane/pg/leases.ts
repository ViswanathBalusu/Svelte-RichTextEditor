/**
 * Node leases in PostgreSQL (migration 0033; 06 §2.1; BE-018). The expiry is computed and judged
 * by the database's `now()` alone, never by a node's clock; a node proves its own lease with its
 * monotonic clock from the moment it sent the renewal (lease.ts).
 */
import type { Pool } from '../../storage/db.ts';
import type { NodeLeaseStore } from '../../storage/types.ts';

export class PgNodeLeases implements NodeLeaseStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async renew(node: string, leaseMs: number): Promise<void> {
    await this.#pool.query(
      `INSERT INTO node_leases (node, expires_at, renewed_at, started_at)
       VALUES ($1, now() + make_interval(secs => $2 / 1000.0), now(), now())
       ON CONFLICT (node) DO UPDATE
         SET expires_at = excluded.expires_at, renewed_at = excluded.renewed_at`,
      [node, Math.max(1, Math.round(leaseMs))],
    );
  }

  async alive(node: string): Promise<boolean> {
    const r = await this.#pool.query(
      'SELECT 1 FROM node_leases WHERE node = $1 AND expires_at > now()',
      [node],
    );
    return r.rowCount === 1;
  }

  async release(node: string): Promise<void> {
    await this.#pool.query('DELETE FROM node_leases WHERE node = $1', [node]);
  }
}
