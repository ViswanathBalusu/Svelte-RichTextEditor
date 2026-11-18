/**
 * History as the requester's projection (ADR 0019 decision item 5; HIS-046; review SR-M4).
 *
 * Every surface that returns content, text, attribution or field values takes the requester's
 * hidden set and serves the projection of their *current* access, behind the `minVisibleSeq` gate
 * (07 §8). An old version can hold a region that is gone or a field that has changed since, so the
 * hidden set of a history read is the union of what the requester's current access hides in each
 * version the read touches and in the head (`hiddenAcross`): a region deleted since keeps its
 * policy in the old version, and a confidential one has lost its grants with it, so it stays
 * hidden; a value that is sensitive now is hidden in old versions too (ADR 0051).
 */
import {
  type Access,
  type Connection,
  type ContentGate,
  type ContentSource,
  type HiddenSet,
  type PermissionState,
  type Projection,
  contentAt,
  hiddenSet,
  hidesNothing,
  project,
  projectionSchema,
  stateVisible,
} from '@docedit/authority';
import { REDACTED_FIELD_ATTRIBUTES } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';
import { type AttributionMap, HIDDEN_AUTHOR, projectAttribution } from './attribution.ts';
import { PLACEHOLDER, indexDocument } from './blocks.ts';
import {
  type CompareSource,
  type Comparison,
  type ComparisonCache,
  type RegionSummary,
  compare,
  summarise,
} from './compare.ts';
import { type GroupOptions, type HistoryItem, listHistory } from './groups.ts';
import { derivedId } from './restore.ts';
import {
  type CommitMeta,
  type HistoryGate,
  type HistoryResult,
  type StoredVersion,
  refuse,
} from './types.ts';

/** The union of hidden sets: hidden when any of them hides it. */
export function unionHidden(...sets: readonly HiddenSet[]): HiddenSet {
  const regions = new Set<string>();
  const values = new Set<string>();
  let titles = sets.length > 0;
  for (const s of sets) {
    for (const r of s.regions) regions.add(r);
    for (const v of s.values) values.add(v);
    // Titles are shown only when every set shows them.
    titles = titles && s.titles;
  }
  return { regions, values, titles };
}

/** What the requester's current access hides in any of `docs` (the head among them). */
export function hiddenAcross(
  conn: Connection,
  docs: readonly Node[],
  perms: PermissionState,
  now: number,
  options: { titles?: boolean } = {},
): HiddenSet {
  return unionHidden(...docs.map((d) => hiddenSet(conn, d, perms, now, options)));
}

/** An old version as the requester may read it (HIS-010 with HIS-046): gate first, then projection. */
export function versionFor(
  seq: number,
  source: ContentSource,
  gate: ContentGate,
  hidden: HiddenSet,
): HistoryResult<{ seq: number; projection: Projection }> {
  const r = contentAt(seq, source, gate);
  if (!r.ok) return refuse(r.code, r.reason);
  return { ok: true, seq, projection: project(r.doc, hidden, projectionSchema()) };
}

export interface AttributionSpanOut {
  blockId: string;
  /** Offsets in the block's content, in the projection. */
  from: number;
  to: number;
  user: string;
  seq: number;
  agent?: string;
  restoredBy?: string;
  restoredSeq?: number;
  /**
   * Set when the content was written below the reader's gate: an unknown person (owner decision
   * 37; HIS-026 criterion 3). `user` is empty, `seq` is `UNKNOWN_SEQ` and no agent is named, so the
   * author and the time are withheld.
   */
  unknown?: true;
}

/** The `seq` of a span whose author is withheld: a value no commit has. */
export const UNKNOWN_SEQ = -1;

export interface AttributionQuery {
  /** The full document at the version asked about, and its attribution map. */
  doc: Node;
  map: AttributionMap;
  seq: number;
  gate: HistoryGate;
  hidden: HiddenSet;
  /** A region, or a list of block identifiers; neither means the whole body. */
  region?: string;
  blocks?: readonly string[];
}

/**
 * "Who wrote this" (05 §6.2 `/attribution`; HIS-015 with HIS-046): the runs that cover each leaf
 * block asked about, as offsets in the requester's projection. A hidden region, or a block inside
 * one, is refused as if it did not exist.
 */
export function attributionFor(
  q: AttributionQuery,
): HistoryResult<{ seq: number; spans: AttributionSpanOut[] }> {
  if (!stateVisible(q.gate.min, q.seq, q.gate.head, q.gate.named))
    return refuse('forbidden', `seq ${q.seq} is below your visibility gate`);
  if (q.region !== undefined && q.hidden.regions.has(q.region))
    return refuse('not_found', `no region ${q.region}`);
  const p = project(q.doc, q.hidden, projectionSchema());
  const map = projectAttribution(q.map, p.spans);
  const index = indexDocument(p.doc);
  if (q.region !== undefined) {
    const r = index.blocks.get(q.region);
    if (!r || r.type !== 'region') return refuse('not_found', `no region ${q.region}`);
  }
  for (const b of q.blocks ?? [])
    if (!index.blocks.has(b) || index.blocks.get(b)!.type === PLACEHOLDER)
      return refuse('not_found', `no block ${b}`);
  const wanted = q.blocks ? new Set(q.blocks) : null;
  const spans: AttributionSpanOut[] = [];
  for (const e of index.order) {
    if (!e.leaf || e.type === PLACEHOLDER) continue;
    if (q.region !== undefined && e.region !== q.region) continue;
    if (wanted && !wanted.has(e.id) && !e.path.some((id) => wanted.has(id))) continue;
    const start = e.pos + 1;
    for (const r of map.slice(start, start + e.node.content.size)) {
      if (r.user === HIDDEN_AUTHOR.user && r.seq === HIDDEN_AUTHOR.seq) continue;
      const from = r.from - start;
      const to = from + r.len;
      if (r.seq < q.gate.min) {
        // Written below the gate: an unknown person, with nothing of the commit (decision 37).
        // A restore at or above the gate is a visible commit, so it stays named.
        const s: AttributionSpanOut = {
          blockId: e.id,
          from,
          to,
          user: '',
          seq: UNKNOWN_SEQ,
          unknown: true,
        };
        if (r.restoredSeq !== undefined && r.restoredSeq >= q.gate.min) {
          if (r.restoredBy !== undefined) s.restoredBy = r.restoredBy;
          s.restoredSeq = r.restoredSeq;
        }
        const last = spans[spans.length - 1];
        if (
          last?.unknown &&
          last.blockId === e.id &&
          last.to === from &&
          last.restoredBy === s.restoredBy &&
          last.restoredSeq === s.restoredSeq
        )
          last.to = to;
        else spans.push(s);
        continue;
      }
      const s: AttributionSpanOut = {
        blockId: e.id,
        from,
        to,
        user: r.user,
        seq: r.seq,
      };
      if (r.agent !== undefined) s.agent = r.agent;
      if (r.restoredBy !== undefined) s.restoredBy = r.restoredBy;
      if (r.restoredSeq !== undefined) s.restoredSeq = r.restoredSeq;
      spans.push(s);
    }
  }
  return { ok: true, seq: q.seq, spans };
}

export interface FieldHistoryEntry {
  seq: number;
  user: string;
  agent?: string;
  session: string;
  time: number;
  origin: string;
}

/**
 * The history of one field (HIS-016 with HIS-046): the commits whose scopes include `field:<id>`,
 * from the per-scope table, newest first, behind the gate. A field whose value is hidden is refused
 * as if it did not exist.
 */
export function fieldHistory(
  fieldId: string,
  commits: readonly CommitMeta[],
  gate: HistoryGate,
  hidden: HiddenSet,
  exists?: (scope: string) => boolean,
): HistoryResult<{ fieldId: string; entries: FieldHistoryEntry[] }> {
  const scope = `field:${fieldId}`;
  if (hidden.values.has(fieldId) || (exists && !exists(scope)))
    return refuse('not_found', `no field ${fieldId}`);
  const entries = commits
    .filter((c) => c.seq > gate.min && c.seq <= gate.head && c.scopes.includes(scope))
    .sort((a, b) => b.seq - a.seq)
    .map((c) => {
      const e: FieldHistoryEntry = {
        seq: c.seq,
        user: c.user,
        session: c.session,
        time: c.time,
        origin: c.origin,
      };
      if (c.agent !== undefined) e.agent = c.agent;
      return e;
    });
  return { ok: true, fieldId, entries };
}

/**
 * The content of a fork or copy of a version (HIS-022 with HIS-046): the full document for a
 * requester who holds `manage`, otherwise what they may read. A fork is a document of its own, so
 * placeholders cannot stay: hidden regions are left out and hidden values and defaults are cleared.
 */
export function forkContent(full: Node, hidden: HiddenSet, access: Access): Node {
  if (access.docRole.has('manage') || hidesNothing(hidden)) return full;
  const clear = (n: Node): Node => {
    if (n.isText) return n;
    let attrs: Readonly<Record<string, unknown>> = n.attrs;
    if (n.type.name === 'form_field' && hidden.values.has(String(n.attrs['id']))) {
      const next: Record<string, unknown> = { ...n.attrs };
      for (const a of REDACTED_FIELD_ATTRIBUTES) if (a in next) next[a] = null;
      attrs = next;
    }
    const children: Node[] = [];
    n.forEach((c) => {
      if (c.type.name === 'region' && hidden.regions.has(String(c.attrs['id']))) return;
      children.push(clear(c));
    });
    if (n.type.name === 'body' && children.length === 0) {
      const p = n.type.schema.nodes['paragraph']!;
      children.push(p.create({ id: derivedId('fork', String(n.attrs['pageSetup'] ?? ''), 0) }));
    }
    const same =
      attrs === n.attrs &&
      children.length === n.childCount &&
      children.every((c, i) => c === n.child(i));
    return same ? n : n.type.create(attrs, children, n.marks);
  };
  return clear(full);
}

export interface ActivityInput {
  /** The caller's read marker (08 §10): the last `seq` they saw. */
  marker: number;
  /** The caller, whose own commits are left out of the list. */
  user: string;
  gate: HistoryGate;
  hidden: HiddenSet;
  source: CompareSource;
  cache?: ComparisonCache;
  commits: readonly CommitMeta[];
  versions: readonly StoredVersion[];
  options?: GroupOptions;
  limit?: number;
}

export interface Activity {
  fromSeq: number;
  toSeq: number;
  comparison: Comparison;
  summary: RegionSummary[];
  /** The history list of other people's commits since the marker, newest first. */
  items: HistoryItem[];
  nextCursor: string | null;
}

/**
 * What changed since the caller was last here (08 §10; HIS-027 with HIS-046): the comparison from
 * the marker to the head with its summary per region, and the list of other people's commits
 * since, both as the caller's projection. A marker below the caller's gate starts at the gate, so
 * nothing below it is returned. Comment activity, mentions and tasks are added by the service.
 */
export function activitySince(input: ActivityInput): HistoryResult<Activity> {
  const { gate } = input;
  if (!Number.isSafeInteger(input.marker) || input.marker < 0)
    return refuse('validation_failed', `marker ${input.marker} is not a sequence number`);
  const fromSeq = Math.min(Math.max(input.marker, gate.min), gate.head);
  const toSeq = gate.head;
  const c = compare({ fromSeq, toSeq }, input.source, {
    gate,
    hidden: input.hidden,
    ...(input.cache ? { cache: input.cache } : {}),
  });
  if (!c.ok) return c;
  const list = listHistory({
    commits: input.commits.filter((m) => m.seq > fromSeq && m.user !== input.user),
    versions: input.versions.filter((v) => v.seq > fromSeq),
    gate: { ...gate, min: fromSeq },
    hidden: input.hidden,
    ...(input.options ? { options: input.options } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  if (!list.ok) return list;
  return {
    ok: true,
    fromSeq,
    toSeq,
    comparison: c.comparison,
    summary: summarise(c.comparison),
    items: list.items,
    nextCursor: list.nextCursor,
  };
}
