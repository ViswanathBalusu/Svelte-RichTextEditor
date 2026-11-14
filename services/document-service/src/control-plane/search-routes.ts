/**
 * The route `GET /search` (operation `search`; 05 §6.2; 13 §10; BE-054 criterion 2; design in
 * ADR 0243). It answers a service credential with the hits of its own tenant. The pipeline refuses a
 * user token before this handler runs, because the operation takes a service credential only
 * (`security: service`); the check below is the same rule kept at the handler too.
 *
 * Query parameters (ADR 0243): `q` (required, the words searched) and `limit` (required, a positive
 * integer; the spec gives no default and no maximum, so none is set here). The tenant comes from the
 * credential, never from the query. The reply is a list of `{ doc, seq, score }`, one per document,
 * with no total and no visibility class, so that a hidden match is not revealed.
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
    const hits = await svc.search(ctx.caller.tenant, q, {
      limit: Number(raw),
      readable: SEARCH_READABLE_WITHOUT_USER,
    });
    // Only the three fields of the reply leave the index (ADR 0243): no class, no text.
    return json(
      200,
      hits.map((h) => ({ doc: h.doc, seq: h.seq, score: h.score })),
    );
  };

  return { search };
}
