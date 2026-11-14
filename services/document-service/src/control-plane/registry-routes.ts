/**
 * The routes `GET /origins` and `GET /keys` (operations getTenantOrigins and getTenantKeys; 05
 * sections 3.2 and 4; 13 section 10; UX-077 criterion 4). They list what the tenant registered:
 * its allowed origins and its public keys. Both are read only: a change comes from the registration
 * (UX-091) until the administration API writes it (UX-076).
 *
 * The caller's tenant is the one the pipeline verified, so a listing never holds another tenant's
 * entries: the registry answers for the tenant named, and that tenant is the caller's own. A user
 * token is refused with `forbidden` before this handler runs (the operations are service-only).
 * Private key material is never registered, so a listing carries public keys only.
 */
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { TenantKey, TenantRegistry } from './tenants.ts';

function keyView(k: TenantKey): Record<string, unknown> {
  return {
    kid: k.kid,
    use: k.use,
    alg: k.alg,
    thumbprint: k.thumbprint,
    issuer: k.issuer,
    jwk: k.jwk,
  };
}

export function registryRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const registry = (): TenantRegistry => {
    if (!d.tenantRegistry) throw new ApiError('not_found', 'this server keeps no tenant registry');
    return d.tenantRegistry;
  };

  const getTenantOrigins: Handler = async (ctx) => {
    const origins = [...(await registry().origins(ctx.caller.tenant))].sort();
    return json(200, { origins }, { 'Cache-Control': 'no-store' });
  };

  const getTenantKeys: Handler = async (ctx) => {
    const r = registry();
    const user = await r.keys(ctx.caller.tenant, 'user');
    const service = await r.keys(ctx.caller.tenant, 'service');
    return json(200, { keys: [...user, ...service].map(keyView) }, { 'Cache-Control': 'no-store' });
  };

  return { getTenantOrigins, getTenantKeys };
}
