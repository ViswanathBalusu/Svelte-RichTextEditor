/**
 * The route `GET /usage` (operation getTenantUsage; 06 §12; 13 §10; UX-078 criterion 2). It reads
 * the figures of the caller's tenant for one UTC month from `UsageService` (usage.ts). The pipeline
 * has verified the service credential and fixed the tenant; a user token is refused before this
 * handler runs. A server composed without a usage service does not offer the route (`not_found`).
 */
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { isMonth } from './usage.ts';

export function usageRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const getTenantUsage: Handler = async (ctx) => {
    if (!d.usage) throw new ApiError('not_found', 'this server keeps no usage figures');
    const params = ctx.url.searchParams;
    const months = params.getAll('month');
    if (months.length > 1 || [...params.keys()].some((key) => key !== 'month'))
      throw new ApiError('validation_failed', 'only one month parameter is accepted');
    const month = months[0];
    if (month !== undefined && !isMonth(month))
      throw new ApiError('validation_failed', 'the month is YYYY-MM');
    const usage = await d.usage.read(ctx.caller.tenant, month);
    return json(200, usage, { 'Cache-Control': 'no-store' });
  };

  return { getTenantUsage };
}
