/**
 * The routes `POST /documents/{id}/holds`, `DELETE /documents/{id}/holds/{holdId}` and `GET /holds`
 * (operations placeHold, releaseHold and listHolds; 08 section 11; 13 section 10; UX-080 criteria 2
 * and 3; HIS-031). The operations are in `HoldService`
 * (holds.ts). This module reads the query, maps the answers to replies and passes the caller's
 * actor to the placement.
 *
 * The pipeline has already verified the credential and fixed the tenant; a user token is refused
 * with `forbidden` before this handler runs (the operations are service-credential only).
 *
 * A server composed without a hold service does not offer the routes (`not_found`). A list is one
 * page: `limit` 1 to 200 (50 when absent), and `nextCursor` when more holds follow (the signed
 * cursors of the kit, as the other lists use).
 */
import { json, type Kit } from './kit.ts';
import { pageLimit } from './http.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { HoldService } from './holds.ts';

const ROUTE = '/holds';

/** A UUID as the stores keep them (the control plane does not reach the driver, BE-002). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID.test(s);

export function holdRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const service = (): HoldService => {
    if (!d.holds) throw new ApiError('not_found', 'this server keeps no legal holds');
    return d.holds;
  };

  const placeHold: Handler = async (ctx) => {
    const view = await service().place(
      ctx.caller.tenant,
      ctx.params['id'] ?? '',
      ctx.caller.actor,
      await ctx.body(),
    );
    return json(201, view, { 'Cache-Control': 'no-store' });
  };

  const releaseHold: Handler = async (ctx) => {
    const doc = ctx.params['id'] ?? '';
    const hold = ctx.params['holdId'] ?? '';
    // An identifier that is not a UUID names nothing; the answer is the same as for an unknown hold.
    if (!isUuid(doc) || !isUuid(hold)) throw new ApiError('not_found', 'no such hold in force');
    const view = await service().release(ctx.caller.tenant, doc, hold, ctx.caller.actor);
    return json(200, view, { 'Cache-Control': 'no-store' });
  };

  const listHolds: Handler = async (ctx) => {
    const svc = service();
    const limit = pageLimit(ctx.url);
    const raw = ctx.url.searchParams.get('cursor');
    const after = raw === null ? null : k.cursors.open(ROUTE, raw);
    const page = await svc.list(ctx.caller.tenant, after, limit);
    const body: Record<string, unknown> = { items: page.items };
    body['nextCursor'] = page.last === null ? null : k.cursors.issue(ROUTE, page.last);
    return json(200, body, { 'Cache-Control': 'no-store' });
  };

  return { placeHold, releaseHold, listHolds };
}
