/**
 * The comparison and attribution routes of 05 §6.2: `GET /documents/{id}/diff` and `GET
 * /documents/{id}/attribution` (08 §6, §7; HIS-011, HIS-014, HIS-015, HIS-046; PRO-055).
 *
 * The algorithms are in `@docedit/history`. This module loads what they need from storage (the
 * content at the versions asked about, the commits between them, the named versions, the
 * permission data), applies the caller's history gate (07 §8) and read class (ADR 0019) and turns
 * a refusal of the algorithm into the problem it names. Every refusal is made before any rebuild
 * work that the refused request would need.
 *
 * Decisions (proposed, docs/adr/0373-w5-PRO-055-history-reads.md):
 * - the attribution route takes `atSeq` (default the head) and `blocks` (a comma-separated list of
 *   block identifiers) besides `region`; the spec names "a region or a block range" and gives no
 *   member names (gap G68);
 * - the attribution map is replayed from the content at seq 0, which is attributed to the user who
 *   created the document; the service keeps no saved maps yet (06 §4.2 `side.json.zst`). The content
 *   of a snapshot commit (an import or a restore) is attributed to the user of that commit, so a
 *   restore does not keep the original authors in this route;
 * - the wire shapes are `{ fromSeq, toSeq, method, granularity, region?, changes }` and
 *   `{ seq, spans }`; the schemas of `spec/dep` leave the attribution result open.
 */
import { stateVisible } from '@docedit/authority';
import {
  AttributionMap,
  STEP_LIMIT,
  attributionAt,
  attributionFor,
  compare,
  unionHidden,
  type Change,
  type Comparison,
  type HistoryError,
  type HistoryGate,
} from '@docedit/history';
import type { JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { connectionOn, minVisibleSeqOf, regionInfosOfJson } from './gate.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { readerView } from './visibility.ts';
import type { DocRef, DocumentRecord } from '../storage/types.ts';

interface Head {
  seq: number;
  doc: JsonNode;
}

/** A whole number of 0 or more in a query parameter, or `validation_failed`. */
function seqParam(ctx: Ctx, name: string, required: boolean): number | undefined {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null || raw === '') {
    if (required)
      throw new ApiError('validation_failed', `${name} is required`, {
        violations: [{ path: `/${name}`, rule: 'a whole number, 0 or more' }],
      });
    return undefined;
  }
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n))
    throw new ApiError('validation_failed', `${name} is a whole number, 0 or more`, {
      violations: [{ path: `/${name}`, rule: 'a whole number, 0 or more' }],
    });
  return n;
}

/** The problem a refusal of `@docedit/history` names. */
export function problemOf(e: HistoryError): ApiError {
  return new ApiError(e.code, e.reason);
}

/** Everything the history routes read before they look at a `seq` (also used by the restore route). */
export async function historyViewOf(k: Kit, ctx: Ctx, doc: string) {
  const { d } = k;
  const record = await k.liveDocument(ctx, doc);
  const ref = k.refOf(ctx, doc);
  const head = await d.logs.head(ref);
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
  const named = new Set<number>(
    d.versions ? (await d.versions.list(ref, { kind: 'named' })).map((v) => v.seq) : [],
  );
  const gate: HistoryGate = { min, head: head.seq, named: (s) => named.has(s) };
  const conn = connectionOn(ctx.caller, doc);
  /** What the caller's current access hides in any of the documents (ADR 0019; HIS-046). */
  const hiddenIn = (...docs: JsonNode[]) =>
    unionHidden(...docs.map((j) => readerView(d.views, conn, j, perms).hidden));
  return { record, ref, head, headDoc: full.doc, full, perms, gate, conn, hiddenIn };
}

/** Refuses a `seq` above the head or below the gate before any rebuild work. */
export function checkSeq(seq: number, gate: HistoryGate): void {
  if (seq > gate.head)
    throw new ApiError('not_found', `no version at seq ${seq} (head ${gate.head})`);
  if (!stateVisible(gate.min, seq, gate.head, gate.named))
    throw new ApiError('forbidden', `seq ${seq} is below your visibility gate (07 §8)`);
}

/** The `sub` of every user a comparison names, for the wire (G11). */
export async function nameUsers(k: Kit, ctx: Ctx, c: Comparison): Promise<Comparison> {
  const users = new Set<string>();
  for (const ch of c.changes) {
    if (ch.user) users.add(ch.user);
    for (const s of ch.spans ?? []) {
      if (s.user) users.add(s.user);
      if (s.restoredBy) users.add(s.restoredBy);
    }
  }
  const name = await k.subsOf(ctx.caller.tenant, [...users]);
  const rename = (ch: Change): Change => {
    const out: Change = { ...ch };
    if (ch.user) out.user = name(ch.user);
    if (ch.spans)
      out.spans = ch.spans.map((s) => ({
        ...s,
        ...(s.user ? { user: name(s.user) } : {}),
        ...(s.restoredBy ? { restoredBy: name(s.restoredBy) } : {}),
      }));
    return out;
  };
  return { ...c, changes: c.changes.map(rename) };
}

export function historyReadRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;
  const schema = cdmSchema();
  const viewOf = (ctx: Ctx, doc: string) => historyViewOf(k, ctx, doc);

  const contentAt = async (ref: DocRef, incarnation: string, seq: number, head: Head) =>
    seq === head.seq ? head.doc : (await d.content.rebuild(ref, incarnation, seq)).doc;

  /**
   * The attribution map at `seq` (08 §7): replayed from the content at seq 0 over the stored
   * commits. A snapshot commit starts a map of its own user.
   */
  const attributionMapAt = async (
    ref: DocRef,
    record: DocumentRecord,
    inc: string,
    seq: number,
  ) => {
    const first = schema.nodeFromJSON((await d.content.rebuild(ref, inc, 0)).doc);
    const map0 = AttributionMap.create(first.content.size, { user: record.createdBy, seq: 0 });
    const commits = seq > 0 ? await d.logs.read(ref, 1, seq) : [];
    const snapshots = new Map<number, AttributionMap>();
    for (const c of commits) {
      if (c.kind !== 'snapshot') continue;
      const node = schema.nodeFromJSON((await d.content.rebuild(ref, inc, c.seq)).doc);
      snapshots.set(c.seq, AttributionMap.create(node.content.size, { user: c.user, seq: c.seq }));
    }
    const r = attributionAt(seq, {
      schema,
      checkpoints: [{ seq: 0, map: map0 }],
      commits: (after, to) => commits.filter((c) => c.seq > after && c.seq <= to),
      snapshot: (c) => snapshots.get(c.seq),
    });
    if (!r.ok) throw new ApiError('internal', r.reason);
    return r.map;
  };

  const getDiff: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.history', doc);
    // The document is resolved first, so a caller of another tenant is refused before any parameter is read.
    const v = await viewOf(ctx, doc);
    const fromSeq = seqParam(ctx, 'fromSeq', true)!;
    const toSeq = seqParam(ctx, 'toSeq', true)!;
    const rawGranularity = ctx.url.searchParams.get('granularity');
    const granularity: 'word' | 'char' | null =
      rawGranularity === 'word' || rawGranularity === 'char' ? rawGranularity : null;
    if (rawGranularity !== null && granularity === null)
      throw new ApiError('validation_failed', 'granularity is word or char', {
        violations: [{ path: '/granularity', rule: 'word or char' }],
      });
    const region = ctx.url.searchParams.get('region') ?? undefined;
    if (toSeq < fromSeq)
      throw new ApiError('validation_failed', `fromSeq ${fromSeq} is above toSeq ${toSeq}`);
    checkSeq(fromSeq, v.gate);
    checkSeq(toSeq, v.gate);
    const inc = v.head.incarnation;
    const from = await d.content.rebuild(v.ref, inc, fromSeq);
    const to = toSeq === fromSeq ? from : await d.content.rebuild(v.ref, inc, toSeq);
    const nodes = new Map([
      [fromSeq, schema.nodeFromJSON(from.doc)],
      [toSeq, schema.nodeFromJSON(to.doc)],
    ]);
    // The steps are read only for versions near enough to be compared from them (08 §6).
    const commits =
      toSeq - fromSeq <= STEP_LIMIT ? await d.logs.read(v.ref, fromSeq + 1, toSeq) : [];
    const request = {
      fromSeq,
      toSeq,
      ...(region !== undefined ? { region } : {}),
      ...(granularity !== null ? { granularity } : {}),
    };
    const source = {
      schema,
      incarnation: inc,
      content: (seq: number) => nodes.get(seq),
      commits: (after: number, upTo: number) =>
        commits.filter((c) => c.seq > after && c.seq <= upTo),
    };
    const ctxOf = { gate: v.gate, hidden: v.hiddenIn(v.headDoc, from.doc, to.doc) };
    let r = compare(request, source, ctxOf);
    // A comparison by alignment names the authors from the attribution map at `toSeq`.
    if (r.ok && r.comparison.method === 'aligned') {
      const map = await attributionMapAt(v.ref, v.record, inc, toSeq);
      r = compare(request, { ...source, attribution: () => map }, ctxOf);
    }
    if (!r.ok) throw problemOf(r);
    return json(200, await nameUsers(k, ctx, r.comparison), {
      'Cache-Control': 'private, no-cache',
    });
  };

  const getAttribution: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'read.history', doc);
    const v = await viewOf(ctx, doc);
    const seq = seqParam(ctx, 'atSeq', false) ?? v.gate.head;
    const region = ctx.url.searchParams.get('region') ?? undefined;
    const blocksParam = ctx.url.searchParams.get('blocks');
    const blocks =
      blocksParam !== null && blocksParam !== ''
        ? blocksParam.split(',').filter((b) => b !== '')
        : undefined;
    checkSeq(seq, v.gate);
    const at = await contentAt(v.ref, v.head.incarnation, seq, {
      seq: v.head.seq,
      doc: v.headDoc,
    });
    const map = await attributionMapAt(v.ref, v.record, v.head.incarnation, seq);
    const r = attributionFor({
      doc: schema.nodeFromJSON(at),
      map,
      seq,
      gate: v.gate,
      hidden: v.hiddenIn(v.headDoc, at),
      ...(region !== undefined ? { region } : {}),
      ...(blocks ? { blocks } : {}),
    });
    if (!r.ok) throw problemOf(r);
    const name = await k.subsOf(
      ctx.caller.tenant,
      r.spans.flatMap((s) => [s.user, ...(s.restoredBy ? [s.restoredBy] : [])]),
    );
    const spans = r.spans.map((s) => ({
      ...s,
      user: name(s.user),
      ...(s.restoredBy ? { restoredBy: name(s.restoredBy) } : {}),
    }));
    return json(200, { seq: r.seq, spans }, { 'Cache-Control': 'private, no-cache' });
  };

  return { getDiff, getAttribution };
}
