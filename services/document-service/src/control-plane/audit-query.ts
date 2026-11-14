/**
 * The audit query of `GET /audit` (UX-081; 13 section 10; 07 section 14; 05 section 6.2).
 *
 * The operation reads the tenant's audit trail (`AuditStore`, BE-014) with filters on document,
 * actor, event kind and time range, and pages the result with an opaque cursor, at most 200 per
 * page. Only a service credential may call it (a user token is refused with `forbidden`). Each
 * event is projected to a fixed set of fields, so no document content and no token is returned:
 * the event's `data` is kept only as its `scopes` list.
 *
 * The route `getAudit` is in `audit-routes.ts`: it reads the URL's query (`auditParamsOf`) and
 * calls `AuditQueryService.query` with the caller the pipeline verified.
 *
 * Not built here, and kept out on purpose:
 * - the events of 07 section 14 that nothing records yet (lease breaks, session revocations,
 *   restores, workflow transitions, region state changes): the audit trail holds what the writers
 *   record today, so the query is complete only for those;
 * - an audit record for each administration action (UX-076 to UX-080), which needs those APIs.
 *
 * Decisions taken here (the spec leaves them open; see docs/adr/0237-lane-UX-079-091.md):
 * - the default page size is 50 when `limit` is absent; the maximum is 200 (UX-081 criterion 2);
 * - `from` and `to` are ISO 8601 date-times with a time zone; `from` is inclusive and `to`
 *   exclusive, as in the store's `AuditQuery` (storage/types.ts);
 * - a parameter given twice is refused (`validation_failed`), not read as its first or last value;
 * - the cursor encodes the (time, identifier) of the last event returned, so a page continues
 *   after it in the store's order (time, then identifier).
 */
import type { AuditEvent, AuditStore } from '../storage/types.ts';
import type { Caller } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { Answer } from './webhook-subscriptions.ts';

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
/** The most events one store call returns (PgAuditStore clamps to 1000). */
export const STORE_PAGE = 1000;

const PARAMS = new Set(['document', 'actor', 'kind', 'from', 'to', 'limit', 'cursor']);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The query parameters as they arrive from the URL: each one a string or absent. */
export type AuditParams = Readonly<Record<string, string | undefined>>;

/** One event as the query returns it. No `data` member: only the scopes list (criterion 6). */
export interface AuditItem {
  id: string;
  document: string | null;
  actor: string;
  kind: string;
  scopes: string[];
  /** Server time, ISO 8601 in UTC. */
  at: string;
}

export interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

export interface AuditQueryDeps {
  store: AuditStore;
}

interface ParsedQuery {
  document: string | undefined;
  actor: string | undefined;
  kind: string | undefined;
  from: number | undefined;
  to: number | undefined;
  limit: number;
  after: { at: number; id: string } | null;
}

function invalid(path: string, rule: string): never {
  throw new ApiError('validation_failed', 'the audit query is not usable', {
    violations: [{ path, rule }],
  });
}

function text(params: AuditParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > 200)
    invalid(`/${name}`, 'a non-empty text of at most 200 characters');
  return value;
}

function instant(params: AuditParams, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!ISO_DATE_TIME.test(value)) invalid(`/${name}`, 'an ISO 8601 date-time with a time zone');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) invalid(`/${name}`, 'an ISO 8601 date-time with a time zone');
  return ms;
}

function limitOf(params: AuditParams): number {
  const value = params['limit'];
  if (value === undefined) return AUDIT_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,3}$/.test(value)) invalid('/limit', 'a whole number from 1 to 200');
  const n = Number(value);
  if (n > AUDIT_MAX_LIMIT) invalid('/limit', `at most ${AUDIT_MAX_LIMIT}`);
  return n;
}

/** The cursor is opaque to clients: base64url of `{"at":…,"id":…}`. */
export function encodeCursor(e: { at: number; id: string }): string {
  return Buffer.from(JSON.stringify({ at: e.at, id: e.id }), 'utf8').toString('base64url');
}

function cursorOf(value: string | undefined): { at: number; id: string } | null {
  if (value === undefined) return null;
  const bad = (): never => invalid('/cursor', 'a cursor from an earlier page');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  if (typeof parsed !== 'object' || parsed === null) return bad();
  const { at, id } = parsed as { at?: unknown; id?: unknown };
  if (typeof at !== 'number' || !Number.isSafeInteger(at)) return bad();
  if (typeof id !== 'string' || !/^[0-9A-Za-z-]{1,64}$/.test(id)) return bad();
  return { at, id };
}

/**
 * The query parameters of a request URL as `AuditParams`. A parameter given twice is refused, so
 * that `?document=a&document=b` is never read as one of the two.
 */
export function auditParamsOf(url: URL): AuditParams {
  const out: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(out, name)) invalid(`/${name}`, 'given at most once');
    out[name] = value;
  }
  return out;
}

export function parseAuditParams(params: AuditParams): ParsedQuery {
  for (const name of Object.keys(params))
    if (!PARAMS.has(name)) invalid(`/${name}`, 'not a parameter of GET /audit');
  const from = instant(params, 'from');
  const to = instant(params, 'to');
  if (from !== undefined && to !== undefined && from >= to) invalid('/to', 'later than from');
  return {
    document: text(params, 'document'),
    actor: text(params, 'actor'),
    kind: text(params, 'kind'),
    from,
    to,
    limit: limitOf(params),
    after: cursorOf(params['cursor']),
  };
}

/** The store's order: time, then identifier (08 section 2; the same order PgAuditStore uses). */
function compare(a: { at: number; id: string }, b: { at: number; id: string }): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function projectOf(e: AuditEvent): AuditItem {
  const raw = e.data['scopes'];
  const scopes = Array.isArray(raw) && raw.every((s) => typeof s === 'string') ? [...raw] : [];
  return {
    id: e.id,
    document: e.doc,
    actor: e.actor,
    kind: e.kind,
    scopes,
    at: new Date(e.at).toISOString(),
  };
}

/**
 * `GET /audit`: a page of the caller's tenant's events, for a service credential. Named apart from
 * the store's `AuditQuery` filter type (storage/types.ts).
 */
export class AuditQueryService {
  readonly #store: AuditStore;

  constructor(deps: AuditQueryDeps) {
    this.#store = deps.store;
  }

  async query(caller: Caller, params: AuditParams): Promise<Answer> {
    // The pipeline already refuses a user token on this route (its credential rule); the check
    // stays here so that the operation is safe wherever it is called from (criterion 3).
    if (caller.kind !== 'service')
      throw new ApiError('forbidden', 'the audit trail needs a service credential (07 §12)');
    const q = parseAuditParams(params);
    const after = q.after;
    const seen = new Map<string, AuditEvent>();
    const beyondCursor = (e: AuditEvent): boolean => after === null || compare(e, after) > 0;
    // The store returns at most STORE_PAGE events per call, oldest first. Read on from the last
    // time seen until the page is full or the store has no more; the identifiers seen are kept so
    // that an event returned twice is counted once.
    let lower = after !== null ? Math.max(after.at, q.from ?? after.at) : q.from;
    for (;;) {
      const batch = await this.#store.query(caller.tenant, {
        ...(q.document !== undefined ? { doc: q.document } : {}),
        ...(q.actor !== undefined ? { actor: q.actor } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(lower !== undefined ? { from: lower } : {}),
        ...(q.to !== undefined ? { to: q.to } : {}),
        limit: STORE_PAGE,
      });
      let added = 0;
      for (const e of batch) {
        // Another tenant's event is never returned, even if the store gave it (criterion 4).
        if (e.tenant !== caller.tenant || seen.has(e.id) || !beyondCursor(e)) continue;
        seen.set(e.id, e);
        added++;
      }
      if (batch.length < STORE_PAGE || seen.size > q.limit) break;
      const tail = batch.at(-1);
      if (tail === undefined) break;
      const last = tail.at;
      if (last === lower && added === 0)
        throw new ApiError(
          'unavailable',
          'more events share one millisecond than one store read returns; the page cannot be read',
        );
      lower = last;
    }
    const ordered = [...seen.values()].sort(compare);
    const page = ordered.slice(0, q.limit);
    const hasMore = ordered.length > q.limit;
    const last = page[page.length - 1];
    return {
      status: 200,
      body: {
        items: page.map(projectOf),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      } satisfies AuditPage,
    };
  }
}
