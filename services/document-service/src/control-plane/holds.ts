/**
 * Legal holds placed on a document through the administration API (UX-080 criteria 2 and 3; 08
 * section 11; 13 section 10).
 *
 * A hold names a document of the tenant, the reason the service credential gave for it, the actor
 * who placed it and the time. The routes `POST /documents/{id}/holds`, `DELETE
 * /documents/{id}/holds/{holdId}` and `GET /holds` (hold-routes.ts) read and write these records.
 * A release keeps the row (who released it and when) and removes the hold from force: the list, the
 * `legalHold` of the document resource and the held set of the scheduler's sweeps no longer
 * count it (HIS-031; owner decision 85). What a hold suspends is in the sweeps (`heldDocuments`).
 *
 * The shape of a hold (`reason` text, at most 500 characters) is a proposal, recorded in the story
 * notes of UX-080. A document may carry more than one hold; each placement is its own record, and
 * the list names every hold, so a document with two holds is listed twice.
 *
 * Every placement is audited (kind `hold.placed`) after it is stored, as a retention change is
 * (retention.ts), so the audit is not atomic with the placement yet.
 */
import { uuid7 } from '@docedit/model';
import type { AuditStore } from '../storage/types.ts';
import { ApiError } from './problems.ts';

export const HOLD_REASON_MAX = 500;

/** A hold as stored. `placedAt` is server time in milliseconds. */
export interface HoldRow {
  readonly id: string;
  readonly tenant: string;
  readonly document: string;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt: number;
  /** Set when the hold was released (HIS-031; owner decision 85); a released hold is not in force. */
  readonly releasedBy?: string;
  readonly releasedAt?: number;
}

/** A hold as the routes answer it. */
export interface HoldView {
  readonly id: string;
  readonly document: string;
  readonly reason: string;
  readonly placedBy: string;
  /** ISO 8601 in UTC. */
  readonly placedAt: string;
}

function fail(message: string, path: string): never {
  throw new ApiError('validation_failed', message, {
    violations: [{ path, rule: 'a non-empty reason of at most 500 characters' }],
  });
}

/**
 * Checks the body of a placement: an object whose only field is `reason`, a string that is not
 * empty once trimmed and holds at most 500 characters. Anything else is refused with
 * `validation_failed`, and nothing is stored.
 */
export function checkHoldReason(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('a hold is an object with a reason', '/');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'reason') fail(`the hold has no field ${key}`, `/${key}`);
  }
  const reason = o['reason'];
  if (typeof reason !== 'string') fail('reason is a string', '/reason');
  const trimmed = reason.trim();
  if (trimmed.length === 0) fail('reason is not empty', '/reason');
  if ([...trimmed].length > HOLD_REASON_MAX) fail('reason is at most 500 characters', '/reason');
  return trimmed;
}

/** The view of a stored hold. */
export function holdView(row: HoldRow): HoldView {
  return {
    id: row.id,
    document: row.document,
    reason: row.reason,
    placedBy: row.placedBy,
    placedAt: new Date(row.placedAt).toISOString(),
  };
}

/**
 * Storage of the holds. `list` returns at most `limit` holds of the tenant whose identifier is
 * after `after` (or from the first when `after` is null), in identifier order.
 */
export interface HoldStore {
  add(row: HoldRow): Promise<void>;
  /** The holds in force, that is, placed and not released. */
  list(tenant: string, after: string | null, limit: number): Promise<HoldRow[]>;
  /** Whether the document has at least one hold in force (HIS-031 criterion 4). */
  held(tenant: string, document: string): Promise<boolean>;
  /**
   * Releases one hold of the document, once: the hold as it was placed, or null when no such hold
   * is in force (unknown, of another document or tenant, or already released).
   */
  release(
    tenant: string,
    document: string,
    id: string,
    actor: string,
    at: number,
  ): Promise<HoldRow | null>;
}

export class MemoryHoldStore implements HoldStore {
  #rows: HoldRow[] = [];

  async add(row: HoldRow): Promise<void> {
    this.#rows.push(row);
  }

  async held(tenant: string, document: string): Promise<boolean> {
    return this.#rows.some(
      (r) => r.tenant === tenant && r.document === document && r.releasedAt === undefined,
    );
  }

  async release(
    tenant: string,
    document: string,
    id: string,
    actor: string,
    at: number,
  ): Promise<HoldRow | null> {
    const i = this.#rows.findIndex(
      (r) =>
        r.tenant === tenant && r.document === document && r.id === id && r.releasedAt === undefined,
    );
    if (i < 0) return null;
    const row = this.#rows[i]!;
    this.#rows[i] = { ...row, releasedBy: actor, releasedAt: at };
    return row;
  }

  async list(tenant: string, after: string | null, limit: number): Promise<HoldRow[]> {
    return this.#rows
      .filter(
        (r) =>
          r.tenant === tenant && r.releasedAt === undefined && (after === null || r.id > after),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }
}

export interface HoldServiceDeps {
  store: HoldStore;
  /** The audit trail the placements are written to (kind `hold.placed`). */
  audit: AuditStore;
  /**
   * Whether a document exists in the tenant and is not deleted. A document of another tenant
   * answers false, so that its identifier reveals nothing to this tenant.
   */
  documentExists: (tenant: string, document: string) => Promise<boolean>;
  now: () => number;
}

export class HoldService {
  readonly #store: HoldStore;
  readonly #audit: AuditStore;
  readonly #exists: (tenant: string, document: string) => Promise<boolean>;
  readonly #now: () => number;

  constructor(deps: HoldServiceDeps) {
    this.#store = deps.store;
    this.#audit = deps.audit;
    this.#exists = deps.documentExists;
    this.#now = deps.now;
  }

  /**
   * Places a hold on a document. The reason is checked first, then the document is looked up:
   * an unknown document is `not_found` and nothing is stored.
   */
  async place(tenant: string, document: string, actor: string, value: unknown): Promise<HoldView> {
    const reason = checkHoldReason(value);
    if (!(await this.#exists(tenant, document)))
      throw new ApiError('not_found', 'no such document');
    const row: HoldRow = {
      id: uuid7(),
      tenant,
      document,
      reason,
      placedBy: actor,
      placedAt: this.#now(),
    };
    await this.#store.add(row);
    await this.#audit.record([
      {
        id: uuid7(),
        tenant,
        doc: document,
        actor,
        kind: 'hold.placed',
        data: { hold: row.id, reason },
        at: row.placedAt,
      },
    ]);
    return holdView(row);
  }

  /**
   * Releases one hold (HIS-031; owner decision 85). It is audited as the placement is, with the
   * actor and the time (kind `hold.released`). After each release the hook `afterRelease` runs, so
   * that the erasures that no held document blocks any more go ahead. A hold that is not in force,
   * or that belongs to another document or tenant, is `not_found`.
   */
  async release(
    tenant: string,
    document: string,
    holdId: string,
    actor: string,
  ): Promise<HoldView> {
    const at = this.#now();
    const row = await this.#store.release(tenant, document, holdId, actor, at);
    if (row === null) throw new ApiError('not_found', 'no such hold in force');
    await this.#audit.record([
      {
        id: uuid7(),
        tenant,
        doc: document,
        actor,
        kind: 'hold.released',
        data: { hold: row.id, reason: row.reason, placedAt: new Date(row.placedAt).toISOString() },
        at,
      },
    ]);
    await this.afterRelease?.(tenant, document);
    return holdView(row);
  }

  /**
   * Called after a release, with the tenant and the document. The server sets it to run the
   * erasures that waited for the hold (`ErasureRequests.afterRelease`).
   */
  afterRelease: ((tenant: string, document: string) => Promise<unknown>) | undefined;

  /** Whether a hold is in force on the document. Only a boolean leaves here: never the reasons. */
  async inForce(tenant: string, document: string): Promise<boolean> {
    return this.#store.held(tenant, document);
  }

  /** One page of the tenant's holds: at most `limit`, and the identifier of the last one, if more follow. */
  async list(
    tenant: string,
    after: string | null,
    limit: number,
  ): Promise<{ items: HoldView[]; last: string | null }> {
    const rows = await this.#store.list(tenant, after, limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = more ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(holdView), last };
  }

  /**
   * The documents of the tenant that a legal hold covers (BE-046 criterion 4): those with a hold in
   * force, so a released hold no longer keeps its document. Reads the store page by page; the sweeps
   * of the scheduler call it once per tenant and run.
   */
  async heldDocuments(tenant: string): Promise<ReadonlySet<string>> {
    const held = new Set<string>();
    const page = 200;
    let after: string | null = null;
    for (;;) {
      const rows = await this.#store.list(tenant, after, page);
      for (const r of rows) held.add(r.document);
      if (rows.length < page) break;
      after = rows[rows.length - 1]!.id;
    }
    return held;
  }
}
