/**
 * The routes `GET|PUT /retention` and `GET|PUT /documents/{id}/retention` (operations
 * getTenantRetention, setTenantRetention, getDocumentRetention, setDocumentRetention; 08 section 11;
 * 13 section 10; UX-080). The operations are in `RetentionService` (retention.ts). This module reads
 * `If-Match`, maps the answers to replies and passes the caller's actor to the audit.
 *
 * The pipeline has already verified the credential and fixed the tenant; a user token is refused
 * with `forbidden` before this handler runs (the operations are service-credential only).
 *
 * A server composed without a retention service does not offer the routes (`not_found`).
 */
import { checkIfMatch } from './http.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { etagOf, type DocumentPolicyState, type RetentionService } from './retention.ts';

function viewOf(s: DocumentPolicyState): Record<string, unknown> {
  return { policy: s.policy, effective: s.effective, source: s.source };
}

function headers(version: number): Record<string, string> {
  return { 'Cache-Control': 'no-store', ETag: etagOf(version) };
}

export function retentionRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const service = (): RetentionService => {
    if (!d.retention) throw new ApiError('not_found', 'this server keeps no retention policies');
    return d.retention;
  };

  const getTenantRetention: Handler = async (ctx) => {
    const s = await service().tenant(ctx.caller.tenant);
    return json(200, s.policy, headers(s.version));
  };

  const setTenantRetention: Handler = async (ctx) => {
    const svc = service();
    const current = await svc.tenant(ctx.caller.tenant);
    checkIfMatch(ctx.req, etagOf(current.version));
    const r = await svc.setTenant(
      ctx.caller.tenant,
      ctx.caller.actor,
      await ctx.body(),
      current.version,
    );
    return json(200, r.state.policy, headers(r.state.version));
  };

  const getDocumentRetention: Handler = async (ctx) => {
    const s = await service().document(ctx.caller.tenant, ctx.params['id'] ?? '');
    return json(200, viewOf(s), headers(s.version));
  };

  const setDocumentRetention: Handler = async (ctx) => {
    const svc = service();
    const doc = ctx.params['id'] ?? '';
    const current = await svc.document(ctx.caller.tenant, doc);
    checkIfMatch(ctx.req, etagOf(current.version));
    const r = await svc.setDocument(
      ctx.caller.tenant,
      doc,
      ctx.caller.actor,
      await ctx.body(),
      current.version,
    );
    return json(200, viewOf(r), headers(r.version));
  };

  return { getTenantRetention, setTenantRetention, getDocumentRetention, setDocumentRetention };
}
