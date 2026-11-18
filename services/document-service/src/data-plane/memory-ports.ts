/**
 * The ports of phase 1b in process (storage/types.ts): the checkpoint index, the audit trail, the
 * outbox and node leases, with the same conditions as their PostgreSQL versions in pg/. For tests
 * and development compositions; nothing outlives the process.
 */
import { uuid7 } from '@docedit/model';
import type {
  AuditEvent,
  AuditQuery,
  AuditStore,
  CheckpointIndex,
  CheckpointRow,
  DocRef,
  NewOutboxItem,
  NodeInfo,
  NodeTraits,
  NodeLeaseStore,
  OutboxItem,
  OutboxStore,
  OutboxWriter,
} from '../storage/types.ts';

const refKey = (ref: DocRef) => `${ref.tenant}/${ref.doc}`;

export class MemoryCheckpointIndex implements CheckpointIndex {
  readonly #rows = new Map<string, Map<number, CheckpointRow & { setAside: boolean }>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async record(ref: DocRef, row: Omit<CheckpointRow, 'createdAt'>): Promise<void> {
    let m = this.#rows.get(refKey(ref));
    if (!m) this.#rows.set(refKey(ref), (m = new Map()));
    m.set(row.seq, { ...row, createdAt: this.#now(), setAside: false });
  }

  async list(ref: DocRef): Promise<CheckpointRow[]> {
    return [...(this.#rows.get(refKey(ref))?.values() ?? [])]
      .filter((r) => !r.setAside)
      .sort((a, b) => a.seq - b.seq)
      .map(({ setAside: _, ...r }) => r);
  }

  async setAside(ref: DocRef, aboveSeq: number): Promise<number[]> {
    const out: number[] = [];
    for (const r of this.#rows.get(refKey(ref))?.values() ?? [])
      if (r.seq > aboveSeq && !r.setAside) {
        r.setAside = true;
        out.push(r.seq);
      }
    return out.sort((a, b) => a - b);
  }

  /** Every document with a row above `head`, for the new-incarnation command's dry run. */
  documentsBeyond(heads: ReadonlyMap<string, number>): string[] {
    const out: string[] = [];
    for (const [k, rows] of this.#rows) {
      const head = heads.get(k);
      if (head !== undefined && [...rows.values()].some((r) => !r.setAside && r.seq > head))
        out.push(k);
    }
    return out;
  }
}

export class MemoryAudit implements AuditStore {
  readonly events: AuditEvent[] = [];
  /** Set by a test to make every write fail. */
  failing = false;

  async record(events: readonly AuditEvent[]): Promise<void> {
    if (this.failing) throw new Error('the audit store is unavailable');
    for (const e of events) this.events.push(structuredClone(e));
  }

  async query(tenant: string, q: AuditQuery): Promise<AuditEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.tenant === tenant &&
          (q.doc === undefined || e.doc === q.doc) &&
          (q.actor === undefined || e.actor === q.actor) &&
          (q.kind === undefined || e.kind === q.kind) &&
          (q.from === undefined || e.at >= q.from) &&
          (q.to === undefined || e.at < q.to),
      )
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
      .slice(0, q.limit)
      .map((e) => structuredClone(e));
  }
}

interface Held extends OutboxItem {
  lockedBy: string | null;
  lockedUntil: number;
}

export class MemoryOutbox implements OutboxStore {
  readonly #items = new Map<string, Held>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async enqueue(item: NewOutboxItem): Promise<OutboxItem> {
    for (const x of this.#items.values())
      if (x.tenant === item.tenant && x.doc === item.doc && x.commitId === item.commitId)
        return this.#copy(x);
    const held: Held = {
      id: uuid7(),
      tenant: item.tenant,
      doc: item.doc,
      commitId: item.commitId,
      kind: item.kind,
      request: structuredClone(item.request),
      payload: item.payload ?? null,
      state: 'pending',
      result: null,
      attempts: 0,
      createdAt: this.#now(),
      lockedBy: null,
      lockedUntil: 0,
    };
    this.#items.set(held.id, held);
    return this.#copy(held);
  }

  #copy(h: Held): OutboxItem {
    const { lockedBy: _, lockedUntil: __, ...item } = h;
    return {
      ...item,
      request: structuredClone(item.request),
      result: structuredClone(item.result),
    };
  }

  async get(tenant: string, id: string): Promise<OutboxItem | null> {
    const h = this.#items.get(id);
    return h && h.tenant === tenant ? this.#copy(h) : null;
  }

  async claim(node: string, leaseMs: number, limit: number): Promise<OutboxItem[]> {
    const now = this.#now();
    const out: OutboxItem[] = [];
    for (const h of [...this.#items.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (out.length >= limit) break;
      if (h.state !== 'pending' || (h.lockedBy !== null && h.lockedUntil >= now)) continue;
      h.lockedBy = node;
      h.lockedUntil = now + leaseMs;
      h.attempts++;
      out.push(this.#copy(h));
    }
    return out;
  }

  async settle(
    item: Pick<OutboxItem, 'tenant' | 'id'>,
    node: string,
    state: 'done' | 'failed',
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const h = this.#items.get(item.id);
    if (!h || h.tenant !== item.tenant || h.state !== 'pending' || h.lockedBy !== node)
      return false;
    h.state = state;
    h.result = structuredClone(result);
    h.lockedBy = null;
    return true;
  }

  async unlock(item: Pick<OutboxItem, 'tenant' | 'id'>, node: string): Promise<void> {
    const h = this.#items.get(item.id);
    if (h && h.tenant === item.tenant && h.lockedBy === node) {
      h.lockedBy = null;
      h.lockedUntil = 0;
    }
  }

  /** Every item, for tests. */
  get all(): OutboxItem[] {
    return [...this.#items.values()].map((h) => this.#copy(h));
  }
}

/**
 * Outbox items and audit events as one unit in process (BE-039 criterion 1). The events are
 * written first: when the audit store refuses them nothing reaches the outbox, as a rolled-back
 * transaction leaves neither in PostgreSQL.
 */
export class MemoryOutboxWriter implements OutboxWriter {
  readonly #outbox: OutboxStore;
  readonly #audit: AuditStore;

  constructor(outbox: OutboxStore, audit: AuditStore) {
    this.#outbox = outbox;
    this.#audit = audit;
  }

  async write(
    _tenant: string,
    unit: { items: readonly NewOutboxItem[]; events: readonly AuditEvent[] },
  ): Promise<OutboxItem[]> {
    await this.#audit.record(unit.events);
    const out: OutboxItem[] = [];
    for (const item of unit.items) out.push(await this.#outbox.enqueue(item));
    return out;
  }
}

/** Node leases judged by an injected database clock (default the system clock). */
export class MemoryNodeLeases implements NodeLeaseStore {
  readonly #leases = new Map<string, number>();
  readonly #addresses = new Map<string, string>();
  readonly #traits = new Map<string, NodeTraits>();
  readonly #dbNow: () => number;
  /** Set by a test to make renewals fail, as an unreachable database would. */
  failing = false;

  constructor(dbNow: () => number = Date.now) {
    this.#dbNow = dbNow;
  }

  async renew(node: string, leaseMs: number, address?: string, traits?: NodeTraits): Promise<void> {
    if (this.failing) throw new Error('the database is unreachable');
    this.#leases.set(node, this.#dbNow() + leaseMs);
    if (traits === undefined) this.#traits.delete(node);
    else this.#traits.set(node, traits);
    if (address === undefined) this.#addresses.delete(node);
    else this.#addresses.set(node, address);
  }

  async live(): Promise<NodeInfo[]> {
    if (this.failing) throw new Error('the database is unreachable');
    const now = this.#dbNow();
    return [...this.#leases.entries()]
      .filter(([, until]) => until > now)
      .map(([node]) => ({
        node,
        address: this.#addresses.get(node) ?? null,
        region: this.#traits.get(node)?.region ?? null,
        dedicated: this.#traits.get(node)?.dedicated ?? null,
      }))
      .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  }

  async alive(node: string): Promise<boolean> {
    if (this.failing) throw new Error('the database is unreachable');
    const until = this.#leases.get(node);
    return until !== undefined && until > this.#dbNow();
  }

  async release(node: string): Promise<void> {
    this.#leases.delete(node);
    this.#addresses.delete(node);
    this.#traits.delete(node);
  }

  /** When the lease of `node` expires by the database clock, for tests. */
  expiresAt(node: string): number | undefined {
    return this.#leases.get(node);
  }
}
