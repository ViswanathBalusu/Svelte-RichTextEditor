/**
 * `GET /documents/{id}/history` (05 §6.2; 08 §4; HIS-008; HIS-026): the grouped commits and the
 * stored versions, newest first, as a cursor list. The grouping, the filters and the paging are
 * `listHistory` of `@docedit/history`; this module loads the commit metadata and the versions,
 * applies the caller's gate (07 §8) and read class (ADR 0019) and puts the result on the wire.
 *
 * Decisions (proposed; `HistoryGroup` in `spec/dep` is a placeholder, gap G67):
 * - the reply is `{ items, nextCursor }`; a group is `{ type: 'group', day, fromSeq, toSeq,
 *   fromTime, toTime, changes, authors, sessions, origins, versions }` and a version item is
 *   `{ type: 'version', version }`, where a version is the `Version` of `versions-routes.ts`;
 * - times are RFC 3339 strings, as the activity route gives them, and users are the host's `sub`;
 * - the `user` filter names a `sub`, as the wire does; it is matched against the stored surrogates;
 * - `timeZone` is not a parameter: days are UTC days.
 *
 * Commits and versions below the gate are not listed, and a `region` or `field` filter on a scope
 * the reader may not see answers `not_found`, as one that never existed does (08 §4).
 */
import { rangeVisible } from '@docedit/authority';
import { formatTimestamp } from '@docedit/model';
import {
  listHistory,
  type HistoryFilter,
  type HistoryItem,
  type HistoryListInput,
} from '@docedit/history';
import { checkSeq, historyViewOf, problemOf } from './history-reads.ts';
import { pageLimit, seqParam } from './http.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { regionInfosOfJson } from './gate.ts';
import type { StoredVersionRow } from '../storage/versions-store.ts';

type CommitMeta = HistoryListInput['commits'][number];

/** A `region` or `field` identifier as the protocol defines it (16 characters). */
const ID = /^[A-Za-z0-9_-]{16}$/;

function idParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!ID.test(raw))
    throw new ApiError('validation_failed', `${name} is a 16-character identifier`, {
      violations: [{ path: name, rule: 'a 16-character identifier' }],
    });
  return raw;
}

export function historyListRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const listHistoryRoute: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // Row 2 of 07 §12: `view` and the history gate.
    guard(ctx.caller, 'read.history', doc);
    const filter: HistoryFilter = {};
    const region = idParam(ctx.url, 'region');
    if (region !== undefined) filter.region = region;
    const field = idParam(ctx.url, 'field');
    if (field !== undefined) filter.field = field;
    const fromSeq = seqParam(ctx.url, 'fromSeq');
    if (fromSeq !== undefined) filter.fromSeq = fromSeq;
    const toSeq = seqParam(ctx.url, 'toSeq');
    if (toSeq !== undefined) filter.toSeq = toSeq;
    const namedOnly = ctx.url.searchParams.get('namedOnly');
    if (namedOnly !== null) {
      if (namedOnly !== 'true' && namedOnly !== 'false')
        throw new ApiError('validation_failed', 'namedOnly is true or false', {
          violations: [{ path: 'namedOnly', rule: 'true or false' }],
        });
      filter.namedOnly = namedOnly === 'true';
    }
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');

    const view = await historyViewOf(k, ctx, doc);
    const { ref, head, gate } = view;
    // Both ends are places that take a sequence number (07 §8; SEQ_INPUTS): `fromSeq` starts a run
    // whose first state is the one before it, and `toSeq` is a single state. Refused before reading.
    if (fromSeq !== undefined && !rangeVisible(gate.min, Math.max(fromSeq - 1, 0)))
      throw new ApiError(
        'forbidden',
        'fromSeq is below the history visibility of the caller (07 §8)',
      );
    if (toSeq !== undefined) checkSeq(toSeq, gate);
    // Only what the gate allows is read: nothing below it leaves storage for this request.
    const first = Math.max(1, gate.min);
    const logCommits = head.seq >= first ? await d.logs.read(ref, first, head.seq) : [];
    const commits: CommitMeta[] = logCommits.map((c) => ({
      seq: c.seq,
      kind: c.kind,
      user: c.user,
      session: c.session,
      time: c.time,
      origin: c.origin,
      scopes: c.scopes,
    }));
    const versionRows: StoredVersionRow[] = d.versions
      ? await d.versions.list(ref, { minSeq: 0 })
      : [];
    const name = await k.subsOf(ctx.caller.tenant, [
      ...commits.map((c) => c.user),
      ...versionRows.map((v) => v.createdBy),
    ]);
    const userParam = ctx.url.searchParams.get('user');
    if (userParam !== null) {
      const stored = [
        ...new Set([...commits.map((c) => c.user), ...versionRows.map((v) => v.createdBy)]),
      ];
      filter.user = stored.find((s) => name(s) === userParam) ?? '\u0000no-such-user';
    }
    const known = new Set<string>([
      ...regionInfosOfJson(view.headDoc).map((r) => `region:${r.id}`),
      ...logCommits.flatMap((c) => c.scopes),
    ]);
    const hidden = view.hiddenIn(view.headDoc);
    const result = listHistory({
      commits,
      versions: versionRows.map((v) => ({
        seq: v.seq,
        kind: v.kind,
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.note !== undefined ? { note: v.note } : {}),
        createdBy: v.createdBy,
        createdAt: v.createdAt,
      })),
      gate,
      hidden,
      filter,
      limit,
      cursor,
      scopeExists: (scope) => known.has(scope),
    });
    if (!result.ok) throw problemOf(result);
    const wire = (item: HistoryItem) =>
      item.type === 'group'
        ? {
            type: 'group',
            day: item.day,
            fromSeq: item.fromSeq,
            toSeq: item.toSeq,
            fromTime: formatTimestamp(item.fromTime),
            toTime: formatTimestamp(item.toTime),
            changes: item.changes,
            authors: item.authors.map((a) => ({
              user: name(a.user),
              ...(a.agent !== undefined ? { agent: a.agent } : {}),
            })),
            sessions: item.sessions,
            origins: item.origins,
            versions: item.versions.map(versionWire(name)),
          }
        : { type: 'version', version: versionWire(name)(item.version) };
    return json(
      200,
      { items: result.items.map(wire), nextCursor: result.nextCursor },
      { 'Cache-Control': 'private, no-cache' },
    );
  };

  return { listHistory: listHistoryRoute };
}

function versionWire(name: (s: string) => string) {
  return (v: {
    seq: number;
    kind: string;
    name?: string;
    note?: string;
    createdBy: string;
    createdAt: number;
  }) => ({
    seq: v.seq,
    kind: v.kind,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.note !== undefined ? { note: v.note } : {}),
    createdBy: name(v.createdBy),
    createdAt: formatTimestamp(v.createdAt),
  });
}
