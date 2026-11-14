/**
 * The routes `GET|PUT /quotas` (operations getTenantQuotas, setTenantQuotas; 06 section 12; 13
 * section 10; UX-078 criterion 1). The operations are in `QuotaAdminService` (quota-admin.ts). This
 * module reads `If-Match`, maps the answers to replies and passes the caller's actor to the audit.
 *
 * The pipeline has already verified the credential and fixed the tenant; a user token is refused
 * with `forbidden` before this handler runs (the operations are service-credential only).
 *
 * A server composed without a quota service does not offer the routes (`not_found`).
 */
import { checkIfMatch } from './http.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { quotaEtag, type QuotaAdminService } from './quota-admin.ts';
import type { QuotaSettings } from './quotas.ts';

function headers(settings: QuotaSettings): Record<string, string> {
  return { 'Cache-Control': 'no-store', ETag: quotaEtag(settings) };
}

export function quotaRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const service = (): QuotaAdminService => {
    if (!d.quotaAdmin) throw new ApiError('not_found', 'this server keeps no quota settings');
    return d.quotaAdmin;
  };

  const getTenantQuotas: Handler = async (ctx) => {
    const s = await service().get(ctx.caller.tenant);
    return json(200, s, headers(s));
  };

  const setTenantQuotas: Handler = async (ctx) => {
    const svc = service();
    const current = await svc.get(ctx.caller.tenant);
    checkIfMatch(ctx.req, quotaEtag(current));
    const r = await svc.set(ctx.caller.tenant, ctx.caller.actor, await ctx.body());
    return json(200, r.settings, headers(r.settings));
  };

  return { getTenantQuotas, setTenantQuotas };
}
