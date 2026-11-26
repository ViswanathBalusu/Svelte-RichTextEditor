/**
 * The routes `POST /tenant-fonts`, `GET /tenant-fonts/{sha256}` and `DELETE /tenant-fonts/{sha256}`
 * (operations addTenantFont, getTenantFont, removeTenantFont; BE-048). The operations are in
 * `TenantFontService` (tenant-fonts.ts). Adding and removing are for the service credential only;
 * reading a file is for any user or service of the same tenant, and the pipeline has fixed the
 * tenant from the credential, so another tenant's hash is `not_found`.
 *
 * A server composed without the service does not offer the routes (`not_found`).
 */
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { TenantFontService } from './tenant-fonts.ts';

export function tenantFontRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const service = (): TenantFontService => {
    if (!d.tenantFonts) throw new ApiError('not_found', 'this server keeps no tenant fonts');
    return d.tenantFonts;
  };

  const addTenantFont: Handler = async (ctx) =>
    json(201, await service().add(ctx.caller.tenant, ctx.caller.actor, await ctx.body()), {
      'Cache-Control': 'no-store',
    });

  const removeTenantFont: Handler = async (ctx) =>
    json(
      200,
      await service().remove(ctx.caller.tenant, ctx.caller.actor, ctx.params['sha256'] ?? ''),
      {
        'Cache-Control': 'no-store',
      },
    );

  const getTenantFont: Handler = async (ctx) => {
    const sha256 = ctx.params['sha256'] ?? '';
    const file = await service().file(ctx.caller.tenant, sha256);
    if (!file) throw new ApiError('not_found', 'no such font');
    return json(
      200,
      {
        sha256,
        mime: file.contentType,
        content: Buffer.from(file.bytes).toString('base64'),
      },
      // The name is the hash of the content, so the answer never changes; it stays private.
      { 'Cache-Control': 'private, max-age=31536000, immutable' },
    );
  };

  return { addTenantFont, getTenantFont, removeTenantFont };
}
