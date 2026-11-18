/**
 * The routes `GET|PUT /history-visibility` and `GET|PUT /documents/{id}/history-visibility`
 * (operations getTenantHistoryVisibility, setTenantHistoryVisibility, getDocumentHistoryVisibility,
 * setDocumentHistoryVisibility; 08 section 9; 13 section 10; HIS-025). The operations are in
 * `HistoryVisibilityService` (history-visibility.ts). This module reads `If-Match`, maps the
 * answers to replies and tells the rooms of the change.
 *
 * The pipeline has already verified the credential and fixed the tenant; a user token is refused
 * with `forbidden` before this handler runs (the operations are service-credential only), so only
 * the host's tenant administrator can change a setting (ADR 0034 section 2).
 *
 * A server composed without the service does not offer the routes (`not_found`).
 */
import { checkIfMatch } from './http.ts';
import {
  visibilityEtag,
  type DocumentVisibilityState,
  type HistoryVisibilityService,
} from './history-visibility.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

function headers(version: number): Record<string, string> {
  return { 'Cache-Control': 'no-store', ETag: visibilityEtag(version) };
}

function viewOf(s: DocumentVisibilityState): Record<string, unknown> {
  return { setting: s.setting, effective: s.effective, source: s.source };
}

export function historyVisibilityRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const service = (): HistoryVisibilityService => {
    if (!d.historyVisibility)
      throw new ApiError('not_found', 'this server keeps no history visibility settings');
    return d.historyVisibility;
  };

  const getTenantHistoryVisibility: Handler = async (ctx) => {
    const s = await service().tenant(ctx.caller.tenant);
    return json(200, { setting: s.setting }, headers(s.version));
  };

  const setTenantHistoryVisibility: Handler = async (ctx) => {
    const svc = service();
    const current = await svc.tenant(ctx.caller.tenant);
    checkIfMatch(ctx.req, visibilityEtag(current.version));
    const s = await svc.setTenant(
      ctx.caller.tenant,
      ctx.caller.actor,
      await ctx.body(),
      current.version,
    );
    return json(200, { setting: s.setting }, headers(s.version));
  };

  const getDocumentHistoryVisibility: Handler = async (ctx) => {
    const s = await service().document(ctx.caller.tenant, ctx.params['id'] ?? '');
    return json(200, viewOf(s), headers(s.version));
  };

  const setDocumentHistoryVisibility: Handler = async (ctx) => {
    const svc = service();
    const doc = ctx.params['id'] ?? '';
    const current = await svc.document(ctx.caller.tenant, doc);
    checkIfMatch(ctx.req, visibilityEtag(current.version));
    const s = await svc.setDocument(
      ctx.caller.tenant,
      doc,
      ctx.caller.actor,
      await ctx.body(),
      current.version,
    );
    // The room that owns the document picks the new setting up now; any other request reads it.
    d.notifier.documentChanged({ tenant: ctx.caller.tenant, doc });
    return json(200, viewOf(s), headers(s.version));
  };

  return {
    getTenantHistoryVisibility,
    setTenantHistoryVisibility,
    getDocumentHistoryVisibility,
    setDocumentHistoryVisibility,
  };
}
