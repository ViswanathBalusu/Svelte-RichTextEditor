/**
 * The route `GET /search` (operation `search`; 05 §6.2; 13 §10; BE-054 criterion 2; design in
 * ADR 0243). It answers a service credential with the hits of its own tenant. The pipeline refuses a
 * user token before this handler runs, because the operation takes a service credential only
 * (`security: service`); the check below is the same rule kept at the handler too.
 *
 * Query parameters (ADR 0243): `q` (required, the words searched) and `limit` (required, a positive
 * integer; the spec gives no default and no maximum, so none is set here). The tenant comes from the
 * credential, never from the query. The reply holds one item per document,
 * with no total and no visibility class, so that a hidden match is not revealed. The body is
 * `{ items: [{ doc, externalId, seq, score }], nextCursor }` (05 §6.1, D14; UX-084): `cursor` continues
 * after the last hit of an earlier page, ranked by score and then by identifier (ADR 0243).
 *
 * Readable classes: a credential without an acting user may read only the unrestricted text
 * (`full`, ADR 0019). The acting-user filter and the document-level `view` check are not built
 * (ADR 0243 Notes), so a credential that names a user is not served here yet.
 *
 * A server composed without a search index does not offer the route (`not_found`).
 */
import type { SearchHit, SearchQuery } from './search-index.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

/** The index the route queries: the PostgreSQL index or the in-memory one. */
export interface SearchService {
  search(tenant: string, q: string, query: SearchQuery): Promise<SearchHit[]>;
}

/** The classes a credential without an acting user may read (ADR 0019: `full` where nothing is restricted). */
export const SEARCH_READABLE_WITHOUT_USER: ReadonlySet<string> = new Set(['full']);

const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** The cursor is opaque to clients: base64url of `{"s":score,"d":doc}` (the last hit of the page). */
export function encodeCursor(h: { score: number; doc: string }): string {
  return Buffer.from(JSON.stringify({ s: h.score, d: h.doc }), 'utf8').toString('base64url');
}

function cursorOf(value: string | null): { score: number; doc: string } | null {
  if (value === null) return null;
  const bad = (): never => {
    throw new ApiError('validation_failed', 'the cursor is not usable', {
      violations: [{ path: '/cursor', rule: 'a cursor from an earlier page' }],
    });
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  if (typeof parsed !== 'object' || parsed === null) return bad();
  const { s, d } = parsed as { s?: unknown; d?: unknown };
  if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return bad();
  if (typeof d !== 'string' || !/^[0-9A-Za-z-]{1,64}$/.test(d)) return bad();
  return { score: s, doc: d };
}

export function searchRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const search: Handler = async (ctx) => {
    if (ctx.caller.kind !== 'service')
      throw new ApiError('forbidden', 'the route takes a service credential');
    const svc = d.search;
    if (!svc) throw new ApiError('not_found', 'this server keeps no search index');
    const q = ctx.url.searchParams.get('q');
    if (q === null || q.trim() === '')
      throw new ApiError('validation_failed', 'q is required', {
        violations: [{ path: '/q', rule: 'a non-empty query' }],
      });
    const raw = ctx.url.searchParams.get('limit');
    if (raw === null || !POSITIVE_INTEGER.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new ApiError('validation_failed', 'limit is a positive integer', {
        violations: [{ path: '/limit', rule: 'a positive integer' }],
      });
    const after = cursorOf(ctx.url.searchParams.get('cursor'));
    const limit = Number(raw);
    // One live hit more than a page is read, to know whether another page follows. Documents that
    // are gone (deleted since they were indexed) are left out and the next hit takes their place.
    const live: { doc: string; externalId: string | null; seq: number; score: number }[] = [];
    let cursor = after;
    while (live.length <= limit) {
      const want = limit + 1 - live.length;
      const hits = await svc.search(ctx.caller.tenant, q, {
        limit: want,
        readable: SEARCH_READABLE_WITHOUT_USER,
        ...(cursor ? { after: cursor } : {}),
      });
      for (const h of hits) {
        cursor = { score: h.score, doc: h.doc };
        const rec = await d.documents.get({ tenant: ctx.caller.tenant, doc: h.doc });
        if (!rec || rec.deletedAt !== null) continue;
        live.push({ doc: h.doc, externalId: rec.externalId, seq: h.seq, score: h.score });
      }
      if (hits.length < want) break;
    }
    const items = live.slice(0, limit);
    const last = items[items.length - 1];
    // Only the four fields leave the index (ADR 0243): no class, no text.
    return json(200, {
      items,
      nextCursor: live.length > limit && last ? encodeCursor(last) : null,
    });
  };

  return { search };
}
