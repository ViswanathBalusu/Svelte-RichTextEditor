/**
 * The route `POST /documents/{id}/commits/{seq}/tombstone` (operation tombstoneCommit; 08 §13;
 * HIS-040 criterion 3). It replaces one commit's payload with a tombstone (commit-tombstone.ts) and
 * answers with the copies that may still hold the removed text.
 *
 * The pipeline has already verified the credential and fixed the tenant; a user token is refused
 * with `forbidden` before this handler runs (the operation is service-credential only). A hold is
 * refused with `conflict`, and every call is audited with the actor of the credential and the reason.
 * A server composed without the store does not offer the route (`not_found`).
 */
import { checkTombstoneBody } from './commit-tombstone.ts';
import { json, type Kit } from './kit.ts';
import type { Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

export function tombstoneRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const tombstoneCommit: Handler = async (ctx) => {
    if (!d.tombstones) throw new ApiError('not_found', 'this server does not remove payloads');
    const raw = ctx.params['seq'] ?? '';
    if (!/^[0-9]+$/.test(raw))
      throw new ApiError('validation_failed', 'seq is a whole number, 1 or more', {
        violations: [{ path: 'seq', rule: 'a whole number, 1 or more' }],
      });
    const reason = checkTombstoneBody(await ctx.body());
    const result = await d.tombstones.tombstone(
      ctx.caller.tenant,
      ctx.params['id'] ?? '',
      Number(raw),
      ctx.caller.actor,
      reason,
    );
    return json(200, result, { 'Cache-Control': 'no-store' });
  };

  return { tombstoneCommit };
}
