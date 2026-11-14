/**
 * `GET /documents/{id}/activity` (05 §6.2; 08 §10; HIS-027 criteria 3 and 4; PRO-058; lane
 * V-PRO-052-068). It lists the changes other people made since the caller's read marker, and not
 * the caller's own. Only seqs the caller's history visibility gate allows are listed (07 §8; ADR
 * 0034): nothing below the gate is shown, even when the marker is lower.
 *
 * Decisions (proposed, docs/adr/0312-lane-V-PRO-052-068.md):
 * - the reply shape is not defined by the prose (`Activity` is a placeholder in `spec/dep`): it is
 *   `{ marker, head, items, nextCursor }`, each item `{ seq, time, user, origin, scopes, kind }`;
 * - a missing marker counts as 0, so every change by others is listed;
 * - comment activity is not listed: threads (PRO-059) are not built, so there is nothing to list;
 * - a reader whose view hides content gets the list projected for their class (ADR 0019; BE-098):
 *   a change whose scopes touch a region hidden from them is left out, so no item names a hidden
 *   region or tells who worked in it. Items carry no content, so nothing else needs projecting.
 *   (An earlier version answered `unavailable`, as the commit log does; a 5xx is wrong for an
 *   ordinary restricted reader of a read route, and the BE-098 sweep refuses it.)
 */
import { formatTimestamp } from '@docedit/model';
import { pageLimit } from './http.ts';
import { json, type Kit } from './kit.ts';
import { connectionOn, minVisibleSeqOf, regionInfosOfJson } from './gate.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { readerView, type ReaderView } from './visibility.ts';

/** Whether no scope of a change is a region hidden from the class (`region:<id>`; 07 §8). */
function scopesVisible(view: ReaderView, scopes: readonly string[]): boolean {
  if (view.full) return true;
  return scopes.every((s) => !s.startsWith('region:') || !view.hidden.regions.has(s.slice(7)));
}

/** One change by another person, as the activity lists it. */
export interface ActivityItem {
  seq: number;
  time: string;
  user: string;
  origin: string;
  scopes: string[];
  kind: 'steps' | 'snapshot';
}

export function activityRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  const getActivity: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.history', doc);
    if (ctx.caller.kind !== 'user')
      throw new ApiError('forbidden', 'activity is read against a user read marker (08 §10)');
    const store = d.readMarkers;
    if (!store) throw new ApiError('not_found', 'read markers are not offered by this service');
    const record = await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const marker = (await store.get(ref, ctx.caller.actor)) ?? 0;
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const perms = await d.grants.current(ref);
    const min = await minVisibleSeqOf({
      caller: ctx.caller,
      ref,
      record,
      head: head.seq,
      regions: regionInfosOfJson(full.doc),
      perms,
      logs: d.logs,
      now: d.now(),
    });
    const reader = readerView(d.views, connectionOn(ctx.caller, doc), full.doc, perms);
    // Visible seqs are at or above `min` (authority rangeVisible); "since the marker" is above it.
    const floor = Math.max(marker, min - 1);
    const cursor = ctx.url.searchParams.get('cursor');
    const after =
      cursor !== null ? Math.max(floor, Number(d.cursors.open(`activity/${doc}`, cursor))) : floor;
    const limit = pageLimit(ctx.url);
    const to = Math.min(head.seq, after + limit);
    const commits = to > after ? await d.logs.read(ref, after + 1, to) : [];
    // The caller's actor is the user's surrogate, as the commits carry it (read-markers.ts).
    const mine = ctx.caller.actor;
    const others = commits.filter(
      (c) => c.kind !== 'control' && c.user !== mine && scopesVisible(reader, c.scopes),
    );
    const name = await k.subsOf(
      ctx.caller.tenant,
      others.map((c) => c.user),
    );
    const items: ActivityItem[] = others.map((c) => ({
      seq: c.seq,
      time: formatTimestamp(c.time),
      user: name(c.user),
      origin: c.origin,
      scopes: [...c.scopes],
      kind: c.kind === 'snapshot' ? 'snapshot' : 'steps',
    }));
    return json(
      200,
      {
        marker,
        head: head.seq,
        items,
        nextCursor: to < head.seq ? d.cursors.issue(`activity/${doc}`, String(to)) : null,
      },
      { 'Cache-Control': 'private, no-cache' },
    );
  };

  return { getActivity };
}
