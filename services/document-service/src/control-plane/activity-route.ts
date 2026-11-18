/**
 * `GET /documents/{id}/activity` (05 §6.2; 08 §10; HIS-027 criteria 3 and 4; PRO-058; lane
 * V-PRO-052-068). It lists the changes other people made since the caller's read marker, and not
 * the caller's own. Only seqs the caller's history visibility gate allows are listed (07 §8; ADR
 * 0034): nothing below the gate is shown, even when the marker is lower.
 *
 * Decisions (proposed, docs/adr/0312-lane-V-PRO-052-068.md; the additions of HIS-027 are the lane
 * w7 decisions listed below, to be confirmed):
 * - the reply shape is not defined by the prose (`Activity` is a placeholder in `spec/dep`): it is
 *   `{ marker, head, items, nextCursor }`, each item `{ seq, time, user, origin, scopes, kind }`;
 *   the first page (no cursor) also carries `fromSeq`, `comparison`, `summary`, `comments` and
 *   `forYou`;
 * - a missing marker counts as 0, so every change by others is listed;
 * - `comparison` is the comparison from the marker (or the gate, when that is higher) to the head,
 *   made by `compareRange` (the worker thread, and block alignment for a long gap: HIS-011,
 *   HIS-012), with the caller's own changes taken out of it, and `summary` is the summary per
 *   region of what is left (08 §10). It is null when the marker is at the head;
 * - `comments` lists the comments by other people made after the commit the comparison starts at
 *   (`{ thread, comment, author, time, body }`, oldest first, at most 200); a thread in a region
 *   the reader cannot see is left out, as the threads routes leave it out;
 * - `forYou` lists first the comments that mention the caller (`user:<sub>`, or a group of the
 *   token) and then the open threads assigned to the caller (`task`). A task is not limited to the
 *   time since the marker: it waits until the thread is resolved;
 * - a reader whose view hides content gets the list projected for their class (ADR 0019; BE-098):
 *   a change whose scopes touch a region hidden from them is left out, so no item names a hidden
 *   region or tells who worked in it. Items carry no content, so nothing else needs projecting.
 *   (An earlier version answered `unavailable`, as the commit log does; a 5xx is wrong for an
 *   ordinary restricted reader of a read route, and the BE-098 sweep refuses it.)
 */
import { summarise, type Comparison } from '@docedit/history';
import { formatTimestamp } from '@docedit/model';
import { compareRange, historyViewOf, nameUsers } from './history-reads.ts';
import { pageLimit } from './http.ts';
import { json, type Kit } from './kit.ts';
import { mentionsOf } from './mentions.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { readerView, type ReaderView } from './visibility.ts';
import type { StoredThread } from '../storage/thread-store.ts';
import type { DocRef } from '../storage/types.ts';

/** Whether no scope of a change is a region hidden from the class (`region:<id>`; 07 §8). */
function scopesVisible(view: ReaderView, scopes: readonly string[]): boolean {
  if (view.full) return true;
  return scopes.every((s) => !s.startsWith('region:') || !view.hidden.regions.has(s.slice(7)));
}

/** The most threads the activity reads: 20 pages of 200. */
const THREAD_PAGES = 20;

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
  const { d } = k;

  /** The comparison without the caller's own changes (08 §10: the user's own commits are not listed). */
  const withoutOwn = (c: Comparison, mine: string): Comparison => ({
    ...c,
    changes: c.changes.flatMap((ch) => {
      if (ch.user === mine) return [];
      if (!ch.spans) return [ch];
      const spans = ch.spans.filter((x) => x.user !== mine && x.restoredBy !== mine);
      return spans.length > 0 ? [{ ...ch, spans }] : [];
    }),
  });

  /** The threads of the document the reader may see, up to a cap. */
  const threadsOf = async (ref: DocRef, reader: ReaderView) => {
    const store = d.threads;
    const out: StoredThread[] = [];
    if (!store) return out;
    let after: string | undefined;
    for (let page = 0; page < THREAD_PAGES; page++) {
      const got = await store.list(ref, { ...(after !== undefined ? { after } : {}), limit: 200 });
      for (const t of got) if (scopesVisible(reader, t.scope.split('\n'))) out.push(t);
      if (got.length < 200) break;
      after = got[got.length - 1]!.id;
    }
    return out;
  };

  const getActivity: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.history', doc);
    if (ctx.caller.kind !== 'user')
      throw new ApiError('forbidden', 'activity is read against a user read marker (08 §10)');
    const store = d.readMarkers;
    if (!store) throw new ApiError('not_found', 'read markers are not offered by this service');
    const v = await historyViewOf(k, ctx, doc);
    const { ref, head, perms } = v;
    const min = v.gate.min;
    const marker = (await store.get(ref, ctx.caller.actor)) ?? 0;
    const reader = readerView(d.views, v.conn, v.headDoc, perms);
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
    const more = {
      marker,
      head: head.seq,
      items,
      nextCursor: to < head.seq ? d.cursors.issue(`activity/${doc}`, String(to)) : null,
    };
    // The later pages only continue the list of changes.
    if (cursor !== null) return json(200, more, { 'Cache-Control': 'private, no-cache' });

    // The first page: the comparison with its summary, the comments, and what is for the caller.
    const fromSeq = Math.min(Math.max(marker, min), head.seq);
    let comparison: Comparison | null = null;
    if (fromSeq < head.seq)
      comparison = withoutOwn(await compareRange(k, v, fromSeq, head.seq), mine);
    const sinceTime =
      fromSeq === 0 ? 0 : ((await d.logs.read(ref, fromSeq, fromSeq))[0]?.time ?? 0);
    const threads = await threadsOf(ref, reader);
    const identity = ctx.caller.identity;
    const principals = new Set<string>(
      identity
        ? [`user:${identity.sub}`, ...identity.connection.groups.map((g) => `group:${g}`)]
        : [],
    );
    interface Raw {
      thread: string;
      comment: string;
      author: string;
      time: number;
      body: unknown;
      mentions: boolean;
    }
    const raw: Raw[] = [];
    const tasks: StoredThread[] = [];
    for (const t of threads) {
      if (t.state === 'open' && t.assignee !== null && principals.has(t.assignee)) tasks.push(t);
      for (const c of t.comments) {
        if (c.author === mine || c.createdAt <= sinceTime) continue;
        raw.push({
          thread: t.id,
          comment: c.id,
          author: c.author,
          time: c.createdAt,
          body: c.body,
          mentions: mentionsOf(c.body).some((p) => principals.has(p)),
        });
      }
    }
    raw.sort((a, b) => a.time - b.time);
    const nameOf = await k.subsOf(
      ctx.caller.tenant,
      raw.map((r) => r.author),
    );
    const wire = (r: Raw) => ({
      thread: r.thread,
      comment: r.comment,
      author: nameOf(r.author),
      time: formatTimestamp(r.time),
      body: r.body,
    });
    const named = comparison ? await nameUsers(k, ctx, comparison) : null;
    return json(
      200,
      {
        ...more,
        fromSeq,
        comparison: named,
        summary: named ? summarise(named) : [],
        comments: raw.slice(-200).map(wire),
        forYou: [
          ...raw.filter((r) => r.mentions).map((r) => ({ kind: 'mention', ...wire(r) })),
          ...tasks.map((t) => ({ kind: 'task', thread: t.id, state: t.state })),
        ],
      },
      { 'Cache-Control': 'private, no-cache' },
    );
  };

  return { getActivity };
}
