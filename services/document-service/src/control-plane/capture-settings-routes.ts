/**
 * The routes `GET|PUT /workflow/capture-settings` (operations getWorkflowCaptureSettings and
 * setWorkflowCaptureSettings; 12 §7; 13 §10; FRW-042). They read and change the tenant's setting for
 * keeping the IP address and the user agent in participant evidence.
 *
 * The pipeline has verified the credential and fixed the tenant. Both operations are
 * service-credential only (`security: ['service']`), so a user token or a participant token is
 * refused with `forbidden` before this handler runs: only the host's tenant administrator can change
 * the setting. The change is audited by the store with the actor and the time. A server composed
 * without the port does not offer the routes (`not_found`).
 */
import { checkIfMatch } from './http.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import {
  CaptureSettingsConflict,
  type CaptureSettingsState,
} from '../workflow/capture-settings.ts';
import type { CaptureSettings } from '@docedit/authority';

const etagOf = (version: number): string => `"${version}"`;

function headers(version: number): Record<string, string> {
  return { 'Cache-Control': 'no-store', ETag: etagOf(version) };
}

const view = (s: CaptureSettingsState) => ({
  captureNetworkIdentity: s.settings.captureNetworkIdentity,
});

/** Checks a body: an object with `captureNetworkIdentity`, a boolean, and nothing else. */
function checkBody(value: unknown): CaptureSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ApiError('validation_failed', 'a capture setting is an object');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (key !== 'captureNetworkIdentity')
      throw new ApiError('validation_failed', `the capture setting has no field ${key}`);
  const v = o['captureNetworkIdentity'];
  if (typeof v !== 'boolean')
    throw new ApiError('validation_failed', 'captureNetworkIdentity is true or false');
  return { captureNetworkIdentity: v };
}

export function captureSettingsRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const port = () => {
    if (!d.captureSettings)
      throw new ApiError('not_found', 'this server keeps no workflow capture setting');
    return d.captureSettings;
  };

  const getWorkflowCaptureSettings: Handler = async (ctx) => {
    const s = await port().read(ctx.caller.tenant);
    return json(200, view(s), headers(s.version));
  };

  const setWorkflowCaptureSettings: Handler = async (ctx) => {
    const store = port();
    const current = await store.read(ctx.caller.tenant);
    checkIfMatch(ctx.req, etagOf(current.version));
    const to = checkBody(await ctx.body());
    try {
      const done = await store.change(ctx.caller.tenant, ctx.caller.actor, to, current.version);
      return json(200, view(done.state), headers(done.state.version));
    } catch (e) {
      if (e instanceof CaptureSettingsConflict)
        throw new ApiError('precondition_failed', 'the setting changed since the ETag was read');
      throw e;
    }
  };

  return { getWorkflowCaptureSettings, setWorkflowCaptureSettings };
}
