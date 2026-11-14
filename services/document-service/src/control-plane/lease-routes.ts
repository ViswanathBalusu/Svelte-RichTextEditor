/**
 * The lease routes `POST`, `PUT` and `DELETE /documents/{id}/regions/{rid}/lease` (05 section 6.2
 * and 7; 07 sections 10 and 12, rows 10 and 11; PRM-043 to PRM-045; PRO-053 criteria 3 and 4).
 *
 * The rules are in `@docedit/authority` (`leases.ts`). These handlers read the permission state,
 * ask those functions, and store the answer as a grants change under the next revision. The room
 * then records the control commit and sends `perm.changed` (07 section 9). A lease is never part
 * of the document.
 *
 * Decided here, not in the published operations (lane U-PRO-052-068; see
 * docs/adr/0312-lane-U-PRO-052-068.md): the paths name no lease identifier, so the lease's ETag is
 * its identifier in quotes (`"<id>"`). A heartbeat names the lease in force for the holder and the
 * region, and its `If-Match` must carry that ETag. Release takes an optional `If-Match` with the
 * same tag.
 *
 * A service credential holds no lease, so it cannot acquire or renew one. It passes every gate
 * (gate.ts), so it may break a lease, as a user with `manage` does.
 */
import {
  type Lease,
  type PermissionState,
  acquireLease,
  endLease,
  renewLease,
} from '@docedit/authority';
import { formatTimestamp, uuid7 } from '@docedit/model';
import { accessOf, connectionOn, regionInfosOfJson } from './gate.ts';
import { checkIfMatch } from './http.ts';
import { type Kit, json } from './kit.ts';
import type { Ctx, Handler, Reply } from './pipeline.ts';
import { ApiError } from './problems.ts';

/** The ETag of a lease: its identifier in quotes (see the module note). */
const leaseTag = (lease: Lease): string => `"${lease.id ?? ''}"`;

type GrantChange = Parameters<Kit['d']['grants']['change']>[1];

export function leaseRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  /**
   * The body of a lease (05 section 6.2 `Lease`): the identifier, the holder as the host's `sub`
   * (D42; the stored holder is the user's surrogate), and the expiry.
   */
  const leaseBody = async (ctx: Ctx, lease: Lease) => {
    const principal = `user:${lease.holder}`;
    const names = await k.principalNames(ctx.caller.tenant, [principal]);
    return {
      id: lease.id ?? '',
      holder: names(principal).slice(5),
      expiresAt: formatTimestamp(lease.expiresAt),
    };
  };

  /** Reads what a lease decision needs: the region must exist at the head. */
  const load = async (ctx: Ctx, doc: string, rid: string) => {
    await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const regions = regionInfosOfJson(full.doc);
    if (!regions.some((r) => r.id === rid))
      throw new ApiError('not_found', `no region ${rid} at the head`);
    const perms = await d.grants.current(ref);
    return { ref, regions, perms, now: d.now() };
  };

  /** Turns a refused decision into the problem it names (07 section 12). */
  const refusal = (verdict: { code: string; reason: string }): ApiError => {
    // `permission_denied` is the authority's word; the REST problem for it is `forbidden` (07 section 12).
    if (verdict.code === 'permission_denied') return new ApiError('forbidden', verdict.reason);
    if (verdict.code === 'conflict') return new ApiError('conflict', verdict.reason);
    return new ApiError('not_found', verdict.reason);
  };

  /** Stores a grants change under the revision it was decided on, and tells the connected users. */
  const store = async (
    ref: ReturnType<typeof refOf>,
    change: GrantChange,
    perms: PermissionState,
    actor: string,
  ): Promise<PermissionState> => {
    try {
      const next = await d.grants.change(ref, change, { actor, ifRevision: perms.revision });
      d.notifier.permissionsChanged(ref, next);
      return next;
    } catch (e) {
      k.translate(e);
    }
  };

  const acquire: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const rid = ctx.params['rid']!;
    const conn = connectionOn(ctx.caller, doc);
    if (!conn)
      throw new ApiError('forbidden', 'a service credential holds no lease; a user takes one');
    const { ref, regions, perms, now } = await load(ctx, doc, rid);
    const id = uuid7();
    const verdict = acquireLease({
      access: accessOf(conn, regions, perms, now),
      perms,
      region: rid,
      holder: conn.sub,
      now,
      id,
    });
    if (!verdict.ok) throw refusal(verdict);
    // Acquiring again as the holder keeps the lease in force: nothing is stored then.
    if (verdict.lease.id === id)
      await store(ref, { putLeases: [verdict.lease] }, perms, ctx.caller.actor);
    return json(201, await leaseBody(ctx, verdict.lease), {
      ETag: leaseTag(verdict.lease),
      'Cache-Control': 'no-store',
    });
  };

  const heartbeat: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const rid = ctx.params['rid']!;
    const conn = connectionOn(ctx.caller, doc);
    if (!conn) throw new ApiError('forbidden', 'a service credential holds no lease to extend');
    const { ref, perms, now } = await load(ctx, doc, rid);
    const held = perms.leases.find((l) => l.region === rid && l.expiresAt > now);
    if (!held) throw new ApiError('not_found', 'you no longer hold this lease');
    checkIfMatch(ctx.req, leaseTag(held), true);
    const verdict = renewLease({ perms, region: rid, id: held.id ?? '', holder: conn.sub, now });
    if (!verdict.ok) throw refusal(verdict);
    await store(ref, { putLeases: [verdict.lease] }, perms, ctx.caller.actor);
    return json(200, await leaseBody(ctx, verdict.lease), {
      ETag: leaseTag(verdict.lease),
      'Cache-Control': 'no-store',
    });
  };

  const release: Handler = async (ctx): Promise<Reply> => {
    const doc = ctx.params['id']!;
    const rid = ctx.params['rid']!;
    const conn = connectionOn(ctx.caller, doc);
    const { ref, regions, perms, now } = await load(ctx, doc, rid);
    const held = perms.leases.find((l) => l.region === rid && l.expiresAt > now);
    if (!held) throw new ApiError('not_found', 'the region has no lease');
    checkIfMatch(ctx.req, leaseTag(held), false);
    if (conn) {
      const verdict = endLease({
        access: accessOf(conn, regions, perms, now),
        perms,
        region: rid,
        user: conn.sub,
        now,
      });
      if (!verdict.ok) throw refusal(verdict);
    }
    await store(ref, { removeLeases: [rid] }, perms, ctx.caller.actor);
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
  };

  return { acquireLease: acquire, heartbeatLease: heartbeat, releaseLease: release };
}
