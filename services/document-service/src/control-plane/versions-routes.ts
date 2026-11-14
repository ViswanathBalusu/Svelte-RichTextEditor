/**
 * The named-version routes `GET` and `POST /documents/{id}/versions` (05 section 6.2; 08 section 4;
 * HIS-006; PRO-054 criteria 2, 3, 4 and 5; lane U-PRO-052-068).
 *
 * The rules that are in `@docedit/history` (`createVersion`, `VERSION_KINDS`) are not imported here,
 * because `services/document-service` does not depend on that package yet (the main session adds it
 * to package.json). The checks are the same ones, made in `storage/versions-store.ts` and
 * `storage/versions-memory.ts`: a kind outside the seven, a `seq` above the head, and a `seq` below
 * the caller's gate. The `edit somewhere` check is the matrix's row `version.create` (07 section 12),
 * read by `authorise` from `@docedit/authority`.
 *
 * Decided here (docs/adr/0312-lane-U-PRO-052-068.md):
 * - the list holds named versions only (the route is "named versions"); the other kinds are stored
 *   but not listed here;
 * - the list is a cursor list: the cursor names the offset of the next page;
 * - the wire `Version` is `{ seq, kind, name, note }`, as `spec/dep` names it; the creator and the
 *   time are stored but not sent, because the published schema names neither;
 * - a repeated creation for the same `seq` and kind answers 200 with the stored version and sends
 *   no notice (HIS-007 criterion 5); a new one answers 201.
 */
import { authorise } from '@docedit/authority';
import { accessOf, connectionOn, minVisibleSeqOf, regionInfosOfJson } from './gate.ts';
import { pageLimit } from './http.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import type { DocRef, LogStore } from '../storage/types.ts';
import type { StoredVersionRow } from '../storage/versions-store.ts';

/** The body of `POST /documents/{id}/versions` as this module reads it (05 section 6.2). */
interface CreateVersionBody {
  seq?: number;
  name: string;
  note?: string;
}

/** The `Version` of `spec/dep`: a pointer to a `seq` with a kind, its name and note. */
function versionBody(v: StoredVersionRow) {
  return {
    seq: v.seq,
    kind: v.kind,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.note !== undefined ? { note: v.note } : {}),
  };
}

/** Turns a refused store answer into the problem it names. */
function refusal(code: string, reason: string): ApiError {
  if (code === 'forbidden') return new ApiError('forbidden', reason);
  if (code === 'not_found') return new ApiError('not_found', reason);
  return new ApiError('validation_failed', reason);
}

export function versionRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument, emit } = k;

  const store = () => {
    const s = d.versions;
    if (!s) throw new ApiError('not_found', 'versions are not offered by this service');
    return s;
  };

  /** The document at the head, its regions and grants, and the lowest `seq` the caller may see. */
  const viewOf = async (ctx: Ctx, doc: string) => {
    const record = await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const perms = await d.grants.current(ref);
    const regions = regionInfosOfJson(full.doc);
    const min = await minVisibleSeqOf({
      caller: ctx.caller,
      ref,
      record,
      head: head.seq,
      regions,
      perms,
      logs: d.logs,
      now: d.now(),
    });
    return { ref, regions, perms, min };
  };

  /**
   * The chain head of the state at `seq` (08 section 12; HIS-006 criterion 4; lane V-HIS-001-016):
   * the hash of the commit at `seq` where the log store keeps it (`PgLogStore.chainHeadAt`), else
   * the head's chain head when `seq` is the head (`LogStore.state`). Null before the first commit,
   * or when the store can tell neither (the in-memory store below the head); the field is then left
   * out. The name `chainHead` is the placeholder `dep.document.changed.v1` uses (gaps G83).
   */
  const chainHeadOf = async (ref: DocRef, seq: number): Promise<string | null> => {
    const logs = d.logs as LogStore & {
      chainHeadAt?(ref: DocRef, seq: number): Promise<string | null>;
    };
    if (seq === 0) return null;
    if (logs.chainHeadAt) return logs.chainHeadAt(ref, seq);
    if (!logs.state) return null;
    const state = await logs.state(ref);
    return state.seq === seq ? state.chainHead : null;
  };

  const listVersions: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // Row 2 of 07 section 12: `view` and the history gate.
    guard(ctx.caller, 'read.history', doc);
    const s = store();
    const { ref, min } = await viewOf(ctx, doc);
    const rows = await s.list(ref, { kind: 'named', minSeq: min });
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');
    const offset = cursor !== null ? Number(d.cursors.open(`versions/${doc}`, cursor)) : 0;
    const page = rows.slice(offset, offset + limit);
    const next =
      offset + limit < rows.length
        ? d.cursors.issue(`versions/${doc}`, String(offset + limit))
        : null;
    return json(
      200,
      { items: page.map(versionBody), nextCursor: next },
      { 'Cache-Control': 'private, no-cache' },
    );
  };

  const createVersion: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const s = store();
    const body = (await ctx.body()) as CreateVersionBody;
    const { ref, regions, perms, min } = await viewOf(ctx, doc);
    const conn = connectionOn(ctx.caller, doc);
    if (conn) {
      const verdict = authorise('version.create', {
        credential: 'user',
        access: accessOf(conn, regions, perms, d.now()),
        restrictions: ctx.caller.identity!.restrict,
      });
      if (!verdict.ok) throw new ApiError('forbidden', `${verdict.reason} (07 section 12)`);
    }
    const outcome = await s.create(
      ref,
      {
        ...(body.seq !== undefined ? { seq: body.seq } : {}),
        kind: 'named',
        name: body.name,
        ...(body.note !== undefined ? { note: body.note } : {}),
        createdBy: ctx.caller.actor,
        createdAt: d.now(),
      },
      { minSeq: min },
    );
    if (!outcome.ok) throw refusal(outcome.code, outcome.message);
    if (outcome.created) {
      // HIS-006 criterion 4: the event and the webhook carry the seq and the chain head at it.
      const chainHead = await chainHeadOf(ref, outcome.version.seq);
      const data = { seq: outcome.version.seq, ...(chainHead !== null ? { chainHead } : {}) };
      emit(ctx, 'dep.version.created', doc, data);
      k.notify()?.(ref, {
        type: 'version.created',
        resource: `/documents/${doc}/versions`,
        data,
      });
    }
    return json(outcome.created ? 201 : 200, versionBody(outcome.version), {
      'Cache-Control': 'no-store',
    });
  };

  return { listVersions, createVersion };
}
