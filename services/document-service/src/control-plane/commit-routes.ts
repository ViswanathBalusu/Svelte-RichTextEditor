/**
 * `GET /documents/{id}/commits?after=&limit=` (05 §6.2, §5.2; BE-038, BE-098; PRM-041; HIS-024;
 * decision D141): the paged commit log for catch-up.
 *
 * For a user the data plane pages the log (`DataPlane.readCommits`, packet A): it applies the
 * history visibility gate (`after` below the gate is `forbidden`) and serves readers whose class
 * hides nothing; a reader whose class hides content reloads instead (the gateway's rule), which it
 * answers with `unavailable`. A service credential, and a user when the data plane offers no page,
 * read from storage here under the same rules. A page lists commits as `sync.commit` elements in
 * ascending `seq` with the authors' `sub` values, at most `limit` (1 to 200, default 50), and ends
 * before a snapshot commit, which no page can carry: `reset` names its `seq`, and the client
 * reloads the content there (04 §3.2). `nextCursor` continues the page; `after` of a later request
 * may be used instead.
 */
import { NOTHING_HIDDEN, rangeVisible, type LogCommit } from '@docedit/authority';
import { toRemoteCommit } from '@docedit/protocol/bridge';
import type { RemoteCommit } from '@docedit/protocol';
import { connectionOn, minVisibleSeqOf, regionInfosOfJson } from './gate.ts';
import { pageLimit, seqParam } from './http.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { readerView } from './visibility.ts';

export function commitRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  const listCommits: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // Row 2 of 07 §12: `view` and the history gate.
    guard(ctx.caller, 'read.history', doc);
    const record = await liveDocument(ctx, doc);
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');
    const after =
      cursor !== null
        ? Number(d.cursors.open(`commits/${doc}`, cursor))
        : seqParam(ctx.url, 'after');
    if (after === undefined)
      throw new ApiError('validation_failed', 'after names the last seq the client holds', {
        violations: [{ path: 'after', rule: 'a sequence number (05 §6.2)' }],
      });
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    if (after > head.seq)
      throw new ApiError('validation_failed', `after is beyond the head (${head.seq})`, {
        violations: [{ path: 'after', rule: 'at most the head' }],
      });
    const headers = { 'Cache-Control': 'private, no-cache' };
    const next = (n: number | null) =>
      n === null ? null : d.cursors.issue(`commits/${doc}`, String(n));
    const fullView = d.views.token(NOTHING_HIDDEN);
    const identity = ctx.caller.identity;

    if (identity && d.dataPlane?.readCommits) {
      const page = await d.dataPlane.readCommits(identity, doc, after, limit);
      // The data plane serves only readers whose class hides nothing: their view is the full one.
      return json(
        200,
        {
          items: page.items,
          nextCursor: next(page.next),
          head: page.head,
          incarnation: page.incarnation,
          view: fullView,
        },
        headers,
      );
    }

    let view = fullView;
    if (identity) {
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
      // The commits after `after` reveal every state from `after` on (07 §8; ADR 0034).
      if (!rangeVisible(min, after))
        throw new ApiError(
          'forbidden',
          'after is below the history visibility of the caller (07 §8)',
        );
      const reader = readerView(d.views, connectionOn(ctx.caller, doc), full.doc, perms);
      if (!reader.full)
        throw new ApiError(
          'unavailable',
          'a reader whose view hides content reloads instead (ADR 0019)',
          {
            retryAfterS: 0,
          },
        );
      view = reader.token;
    }
    const to = Math.min(head.seq, after + limit);
    const commits: LogCommit[] = to > after ? await d.logs.read(ref, after + 1, to) : [];
    const name = await k.subsOf(
      ctx.caller.tenant,
      commits.map((c) => c.user),
    );
    const items: RemoteCommit[] = [];
    let reset: number | null = null;
    for (const c of commits) {
      if (c.kind === 'snapshot') {
        reset = c.seq;
        break;
      }
      items.push(toRemoteCommit(c, 0, name));
    }
    const last = items.length ? items[items.length - 1]!.seq : after;
    return json(
      200,
      {
        items,
        nextCursor: reset === null && last < head.seq ? next(last) : null,
        head: head.seq,
        incarnation: head.incarnation,
        view,
        ...(reset !== null ? { reset: { seq: reset } } : {}),
      },
      headers,
    );
  };

  return { listCommits };
}
