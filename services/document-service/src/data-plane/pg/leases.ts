/**
 * Node leases in PostgreSQL (migration 0033; 06 §2.1; BE-018). The expiry is computed and judged
 * by the database's `now()` alone, never by a node's clock; a node proves its own lease with its
 * monotonic clock from the moment it sent the renewal (lease.ts).
 */
import type { Pool } from '../../storage/db.ts';
import type { NodeInfo, NodeLeaseStore, NodeTraits } from '../../storage/types.ts';

export class PgNodeLeases implements NodeLeaseStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async renew(node: string, leaseMs: number, address?: string, traits?: NodeTraits): Promise<void> {
    await this.#pool.query(
      `INSERT INTO node_leases (node, expires_at, renewed_at, started_at, address, region, dedicated_doc)
       VALUES ($1, now() + make_interval(secs => $2 / 1000.0), now(), now(), $3, $4, $5)
       ON CONFLICT (node) DO UPDATE
         SET expires_at = excluded.expires_at, renewed_at = excluded.renewed_at,
             address = excluded.address, region = excluded.region,
             dedicated_doc = excluded.dedicated_doc`,
      [
        node,
        Math.max(1, Math.round(leaseMs)),
        address ?? null,
        traits?.region ?? null,
        traits?.dedicated ?? null,
      ],
    );
  }

  async live(): Promise<NodeInfo[]> {
    const r = await this.#pool.query<{
      node: string;
      address: string | null;
      region: string | null;
      dedicated_doc: string | null;
    }>(
      'SELECT node, address, region, dedicated_doc FROM node_leases WHERE expires_at > now() ORDER BY node',
    );
    return r.rows.map((row) => ({
      node: row.node,
      address: row.address,
      region: row.region,
      dedicated: row.dedicated_doc,
    }));
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
