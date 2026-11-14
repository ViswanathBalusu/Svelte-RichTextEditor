/**
 * The route `GET /audit` (operation `getAudit`; 05 section 6.2; 13 section 10; UX-081). The
 * pipeline has already verified the credential and fixed the tenant: the route's credential rule
 * (a service credential) refuses a user token with `forbidden` before this handler runs, and the
 * operation checks it again. The handler reads the URL's query and answers with one page of the
 * caller's tenant's events (`AuditQueryService`, audit-query.ts).
 *
 * A server composed without an audit store does not offer the route (`not_found`), as for the
 * other optional parts of `HandlerDeps`.
 */
import { AuditQueryService, auditParamsOf } from './audit-query.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

export function auditRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;
  // Built on first use: `createHandlers` is also called without dependencies (matrix.test.ts).
  let service: AuditQueryService | null = null;

  const getAudit: Handler = async (ctx) => {
    const store = d.audit;
    if (!store) throw new ApiError('not_found', 'this server keeps no audit trail');
    service ??= new AuditQueryService({ store });
    const answer = await service.query(ctx.caller, auditParamsOf(ctx.url));
    // A page of the audit trail is never cached: it changes as events are recorded.
    return json(answer.status, answer.body, { 'Cache-Control': 'no-store' });
  };

  return { getAudit };
}
