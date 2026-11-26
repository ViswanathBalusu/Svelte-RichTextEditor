/**
 * The time-stamp chain of sealed documents in PostgreSQL, as the renewal job keeps it (12 §8.2
 * step 5; FRW-056 criterion 5; migration 0068 `workflow_renewal_state`; lane V-FRW-055-072).
 *
 * - `start` records the expiry of a sealed document's first time-stamp. The sealing step that calls
 *   it is not built here; a second start for the same document is refused by the primary key.
 * - `claim` reserves the current expiry for one run before that run asks the signing service. It is
 *   one UPDATE whose condition names the expiry and requires that no other claim is live, so of any
 *   number of concurrent runs at most one gets the claim: PostgreSQL locks the row for the first,
 *   and re-reads it for the others once the first commits, and they then see the claim.
 * - `release` drops a claim after a renewal that did not happen, so that a retry can claim again.
 * - `swap` moves the expiry from the claimed one to the next, only for the claim's holder, and
 *   clears the claim, in one UPDATE.
 *
 * Each statement runs in a transaction of the tenant (BE-011), so row-level security limits it to
 * the tenant's rows. Times are epoch milliseconds from the caller's clock.
 */
import type { RenewalState } from '@docedit/authority';
import type { RenewalClaim, RenewalStore } from '../control-plane/jobs/workflow-renewal.ts';
import { inTenant, type Pool } from '../storage/db.ts';

export const WORKFLOW_RENEWAL_STATE_TABLE = 'workflow_renewal_state';

function requireMs(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer of milliseconds`);
}

export class PgRenewalStore implements RenewalStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Records the expiry of the newest time-stamp of a document that was just sealed. A document
   * already recorded is left as it is (a run that is repeated starts nothing twice); the answer says
   * whether this call recorded it.
   */
  async start(tenant: string, doc: string, expiresAtMs: number): Promise<boolean> {
    requireMs('expiresAtMs', expiresAtMs);
    const r = await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `INSERT INTO ${WORKFLOW_RENEWAL_STATE_TABLE} (tenant_id, doc_id, expires_at_ms)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, doc_id) DO NOTHING`,
        [tenant, doc, expiresAtMs],
      ),
    );
    return (r.rowCount ?? 0) === 1;
  }

  /**
   * The documents whose newest time-stamp still holds at `nowMs` and ends within `leadMs`: the ones
   * to renew now, the soonest to end first. An expiry already past is not listed, as nothing can be
   * renewed after it (`planRenewal`).
   */
  async listDue(
    tenant: string,
    nowMs: number,
    leadMs: number,
    limit: number,
  ): Promise<readonly { doc: string; expiresAtMs: number }[]> {
    requireMs('nowMs', nowMs);
    if (!Number.isSafeInteger(leadMs) || leadMs < 0)
      throw new RangeError('leadMs must be a non-negative safe integer of milliseconds');
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<{ d: string; e: string }>(
          `SELECT doc_id AS d, expires_at_ms::text AS e FROM ${WORKFLOW_RENEWAL_STATE_TABLE}
            WHERE tenant_id = $1 AND expires_at_ms > $2 AND expires_at_ms <= $3
            ORDER BY expires_at_ms, doc_id LIMIT $4`,
          [tenant, nowMs, nowMs + leadMs, limit],
        ),
      { readOnly: true },
    );
    return r.rows.map((row) => ({ doc: row.d, expiresAtMs: Number(row.e) }));
  }

  async load(tenant: string, doc: string): Promise<RenewalState | null> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<{ e: string }>(
          `SELECT expires_at_ms::text AS e FROM ${WORKFLOW_RENEWAL_STATE_TABLE}
            WHERE tenant_id = $1 AND doc_id = $2`,
          [tenant, doc],
        ),
      { readOnly: true },
    );
    const row = r.rows[0];
    return row === undefined ? null : { expiresAtMs: Number(row.e) };
  }

  async claim(
    tenant: string,
    doc: string,
    expected: number,
    holder: string,
    nowMs: number,
    untilMs: number,
  ): Promise<RenewalClaim> {
    requireMs('nowMs', nowMs);
    requireMs('untilMs', untilMs);
    if (untilMs <= nowMs) throw new RangeError('untilMs must be later than nowMs');
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        `UPDATE ${WORKFLOW_RENEWAL_STATE_TABLE}
            SET claim_holder = $4, claim_until_ms = $6
          WHERE tenant_id = $1 AND doc_id = $2 AND expires_at_ms = $3
            AND (claim_holder IS NULL OR claim_until_ms <= $5)`,
        [tenant, doc, expected, holder, nowMs, untilMs],
      );
      if ((r.rowCount ?? 0) === 1) return { claimed: true };
      // Refused: say whether another run holds this expiry, or the chain has moved on.
      const q = await c.query<{ e: string; u: string | null }>(
        `SELECT expires_at_ms::text AS e, claim_until_ms::text AS u
           FROM ${WORKFLOW_RENEWAL_STATE_TABLE} WHERE tenant_id = $1 AND doc_id = $2`,
        [tenant, doc],
      );
      const row = q.rows[0];
      if (row === undefined || Number(row.e) !== expected || row.u === null)
        return { claimed: false, heldUntilMs: null };
      return { claimed: false, heldUntilMs: Number(row.u) };
    });
  }

  async release(tenant: string, doc: string, expected: number, holder: string): Promise<void> {
    await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `UPDATE ${WORKFLOW_RENEWAL_STATE_TABLE}
            SET claim_holder = NULL, claim_until_ms = NULL
          WHERE tenant_id = $1 AND doc_id = $2 AND expires_at_ms = $3 AND claim_holder = $4`,
        [tenant, doc, expected, holder],
      ),
    );
  }

  async swap(
    tenant: string,
    doc: string,
    expected: number,
    next: number,
    holder: string,
    nowMs: number,
  ): Promise<boolean> {
    requireMs('next', next);
    const r = await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `UPDATE ${WORKFLOW_RENEWAL_STATE_TABLE}
            SET expires_at_ms = $4, claim_holder = NULL, claim_until_ms = NULL, renewed_at_ms = $6
          WHERE tenant_id = $1 AND doc_id = $2 AND expires_at_ms = $3 AND claim_holder = $5`,
        [tenant, doc, expected, next, holder, nowMs],
      ),
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** The current claim on a document's chain, for operators and tests; null when none is held. */
  async currentClaim(
    tenant: string,
    doc: string,
  ): Promise<{ holder: string; untilMs: number } | null> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<{ h: string | null; u: string | null }>(
          `SELECT claim_holder AS h, claim_until_ms::text AS u
             FROM ${WORKFLOW_RENEWAL_STATE_TABLE} WHERE tenant_id = $1 AND doc_id = $2`,
          [tenant, doc],
        ),
      { readOnly: true },
    );
    const row = r.rows[0];
    if (row === undefined || row.h === null || row.u === null) return null;
    return { holder: row.h, untilMs: Number(row.u) };
  }
}
