/**
 * The route `POST /users/erase` (operation erasePerson; 08 §13; HIS-038 criterion 6). It deletes
 * a person's mapping row, display name and read markers (`ErasureRequests`, erasure-requests.ts)
 * and changes nothing in the log.
 *
 * The pipeline has already verified the credential and fixed the tenant; a user token is refused
 * with `forbidden` before this handler runs (the operation is service-credential only). Every call
 * is audited by `ErasureRequests` (`erasure.run`, or `erasure.deferred` while a legal hold stands),
 * under the actor of the credential. The audit data holds the surrogate, never the `sub`.
 *
 * The `sub` is in the body, not in the path, so that it does not reach access logs. A `sub` the
 * service has not seen is `not_found`. A server composed without an erasure service does not offer
 * the route (`not_found`).
 */
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

const SUB_MAX = 255;

function fail(message: string, path: string): never {
  throw new ApiError('validation_failed', message, {
    violations: [{ path, rule: 'a non-empty sub of at most 255 characters' }],
  });
}

/** Checks the body: an object whose only field is `sub`, a non-empty string of at most 255 characters. */
export function checkErasePerson(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('the body is an object with a sub', '/');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (key !== 'sub') fail(`the body has no field ${key}`, `/${key}`);
  const sub = o['sub'];
  if (typeof sub !== 'string') fail('sub is a string', '/sub');
  if (sub.length === 0) fail('sub is not empty', '/sub');
  if ([...sub].length > SUB_MAX) fail('sub is at most 255 characters', '/sub');
  return sub;
}

export function eraseRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const erasePerson: Handler = async (ctx) => {
    if (!d.erasures) throw new ApiError('not_found', 'this server does not erase people');
    const sub = checkErasePerson(await ctx.body());
    const outcome = await d.erasures.erase(ctx.caller.tenant, sub, ctx.caller.actor);
    if (outcome === 'unknown_person') throw new ApiError('not_found', 'no such person');
    return json(200, { outcome }, { 'Cache-Control': 'no-store' });
  };

  return { erasePerson };
}
