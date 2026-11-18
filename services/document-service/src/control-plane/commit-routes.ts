/**
 * `GET /documents/{id}/commits?after=&limit=` (05 §6.2, §5.2; BE-038, BE-098; PRM-041; HIS-024;
 * decision D141): the paged commit log for catch-up.
 *
 * For a user the data plane pages the log (`DataPlane.readCommits`, packet A): it applies the
 * history visibility gate (`after` below the gate is `forbidden`). A reader whose class hides
 * content gets the steps of the class and its view token (`projectCommitPage`; BE-098; ADR 0019
 * item 2): a commit that changed only hidden content arrives with no steps. A service credential,
 * and a user when the data plane offers no page, read from storage here under the same rules. A page lists commits as `sync.commit` elements in
 * ascending `seq` with the authors' `sub` values, at most `limit` (1 to 200, default 50), and ends
 * before a snapshot commit, which no page can carry: `reset` names its `seq`, and the client
 * reloads the content there (04 §3.2). `nextCursor` continues the page; `after` of a later request
 * may be used instead.
 */
import {
  NOTHING_HIDDEN,
  projectCommitPage,
  rangeVisible,
  type HiddenSet,
  type LogCommit,
  type StoredCommit,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
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
      // A page of a class that hides content names the class's token (BE-098); other pages are the
      // full view.
      return json(
        200,
        {
          items: page.items,
          nextCursor: next(page.next),
          head: page.head,
          incarnation: page.incarnation,
          view: page.view ?? fullView,
        },
        headers,
      );
    }

    let view = fullView;
    let hidden: HiddenSet | null = null;
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
      view = reader.token;
      if (!reader.full) hidden = reader.hidden;
    }
    const to = Math.min(head.seq, after + limit);
    let commits: LogCommit[] = to > after ? await d.logs.read(ref, after + 1, to) : [];
    if (hidden) {
      // The steps of the reader's class, mapped from the stored commits (BE-098; ADR 0019 item 2),
      // for the page up to a snapshot commit, which no page carries.
      const cut = commits.findIndex((c) => c.kind === 'snapshot');
      const stepCommits = (cut < 0 ? commits : commits.slice(0, cut)) as StoredCommit[];
      const before = (await d.content.rebuild(ref, head.incarnation, after)).doc;
      const projected = projectCommitPage(
        cdmSchema(),
        cdmSchema().nodeFromJSON(before),
        hidden,
        stepCommits,
      );
      commits = cut < 0 ? projected : [...projected, ...commits.slice(cut)];
    }
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
