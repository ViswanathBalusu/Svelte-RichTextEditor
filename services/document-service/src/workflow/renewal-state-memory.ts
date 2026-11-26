/**
 * The time-stamp chain of sealed documents in memory (FRW-056; BE-052): the same contract as
 * `PgRenewalStore` for a node without a database and for tests. A claim reserves one expiry for
 * one holder until a time; `swap` moves the expiry only for the holder, in one step.
 */
import type { RenewalState } from '@docedit/authority';
import type {
  RenewalClaim,
  RenewalDueSource,
  RenewalStore,
} from '../control-plane/jobs/workflow-renewal.ts';

interface Row {
  expiresAtMs: number;
  holder: string | null;
  untilMs: number | null;
}

export class MemoryRenewalStore implements RenewalStore, RenewalDueSource {
  readonly #rows = new Map<string, Row>();

  static #key(tenant: string, doc: string): string {
    return `${tenant}\n${doc}`;
  }

  /** Records the expiry of the newest time-stamp of a document that was just sealed. */
  async start(tenant: string, doc: string, expiresAtMs: number): Promise<void> {
    const k = MemoryRenewalStore.#key(tenant, doc);
    if (this.#rows.has(k)) throw new Error('the document already has a time-stamp chain');
    this.#rows.set(k, { expiresAtMs, holder: null, untilMs: null });
  }

  async load(tenant: string, doc: string): Promise<RenewalState | null> {
    const r = this.#rows.get(MemoryRenewalStore.#key(tenant, doc));
    return r === undefined ? null : { expiresAtMs: r.expiresAtMs };
  }

  async listDue(
    tenant: string,
    fromMs: number,
    toMs: number,
    limit: number,
  ): Promise<readonly { readonly doc: string; readonly expiresAtMs: number }[]> {
    const out: { doc: string; expiresAtMs: number }[] = [];
    for (const [k, r] of this.#rows) {
      const [t, doc] = k.split('\n') as [string, string];
      if (t === tenant && r.expiresAtMs > fromMs && r.expiresAtMs <= toMs)
        out.push({ doc, expiresAtMs: r.expiresAtMs });
    }
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
    const r = this.#rows.get(MemoryRenewalStore.#key(tenant, doc));
    if (r === undefined || r.expiresAtMs !== expected) return { claimed: false, heldUntilMs: null };
    if (r.holder !== null && r.untilMs !== null && r.untilMs > nowMs)
      return { claimed: false, heldUntilMs: r.untilMs };
    r.holder = holder;
    r.untilMs = untilMs;
    return { claimed: true };
  }

  async release(tenant: string, doc: string, expected: number, holder: string): Promise<void> {
    const r = this.#rows.get(MemoryRenewalStore.#key(tenant, doc));
    if (r !== undefined && r.expiresAtMs === expected && r.holder === holder) {
      r.holder = null;
      r.untilMs = null;
    }
  }

  async swap(
    tenant: string,
    doc: string,
    expected: number,
    next: number,
    holder: string,
    _nowMs: number,
  ): Promise<boolean> {
    const r = this.#rows.get(MemoryRenewalStore.#key(tenant, doc));
    if (r === undefined || r.expiresAtMs !== expected || r.holder !== holder) return false;
    r.expiresAtMs = next;
    r.holder = null;
    r.untilMs = null;
    return true;
  }
}
