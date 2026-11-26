/**
 * The time-stamp chain of sealed documents in memory: the in-process counterpart of
 * `PgRenewalStore` (renewal-state-pg.ts) with the same rules, for the in-memory service and for
 * tests (FRW-056). Single-threaded, so each step is atomic by running without an await between
 * its read and its write.
 */
import type { RenewalState } from '@docedit/authority';
import type { RenewalClaim, RenewalStore } from '../control-plane/jobs/workflow-renewal.ts';
import type { RenewalRegistry } from './renewal-schedule.ts';

interface Row {
  expiresAtMs: number;
  claim: { holder: string; untilMs: number } | null;
}

export class MemoryRenewalStore implements RenewalStore, RenewalRegistry {
  readonly #rows = new Map<string, Row>();

  #key(tenant: string, doc: string): string {
    return `${tenant}\u0000${doc}`;
  }

  async start(tenant: string, doc: string, expiresAtMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)
      throw new RangeError('expiresAtMs must be a positive safe integer of milliseconds');
    const key = this.#key(tenant, doc);
    if (this.#rows.has(key)) return false;
    this.#rows.set(key, { expiresAtMs, claim: null });
    return true;
  }

  async load(tenant: string, doc: string): Promise<RenewalState | null> {
    const row = this.#rows.get(this.#key(tenant, doc));
    return row === undefined ? null : { expiresAtMs: row.expiresAtMs };
  }

  async listDue(
    tenant: string,
    nowMs: number,
    leadMs: number,
    limit: number,
  ): Promise<readonly { doc: string; expiresAtMs: number }[]> {
    const prefix = `${tenant}\u0000`;
    const out: { doc: string; expiresAtMs: number }[] = [];
    for (const [key, row] of this.#rows)
      if (key.startsWith(prefix) && row.expiresAtMs > nowMs && row.expiresAtMs <= nowMs + leadMs)
        out.push({ doc: key.slice(prefix.length), expiresAtMs: row.expiresAtMs });
    out.sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.doc < b.doc ? -1 : 1));
    return out.slice(0, limit);
  }

  async claim(
    tenant: string,
    doc: string,
    expected: number,
    holder: string,
    nowMs: number,
    untilMs: number,
  ): Promise<RenewalClaim> {
    const row = this.#rows.get(this.#key(tenant, doc));
    if (row === undefined || row.expiresAtMs !== expected)
      return { claimed: false, heldUntilMs: null };
    if (row.claim !== null && row.claim.untilMs > nowMs)
      return { claimed: false, heldUntilMs: row.claim.untilMs };
    row.claim = { holder, untilMs };
    return { claimed: true };
  }

  async release(tenant: string, doc: string, expected: number, holder: string): Promise<void> {
    const row = this.#rows.get(this.#key(tenant, doc));
    if (row !== undefined && row.expiresAtMs === expected && row.claim?.holder === holder)
      row.claim = null;
  }

  async swap(
    tenant: string,
    doc: string,
    expected: number,
    next: number,
    holder: string,
    _nowMs: number,
  ): Promise<boolean> {
    const row = this.#rows.get(this.#key(tenant, doc));
    if (row === undefined || row.expiresAtMs !== expected || row.claim?.holder !== holder)
      return false;
    row.expiresAtMs = next;
    row.claim = null;
    return true;
  }
}
