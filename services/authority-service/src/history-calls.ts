/**
 * The history calls of the authority service (05 §10; PRO-106; 08 §6, §7, §8): `restoreSteps`,
 * `diff` and `attribution`. Each is the function of `@docedit/history` on a state the service
 * holds, with the same checks, so a relay or sidecar backend offers the history features without
 * building them (ADR 0395, proposed).
 *
 * The caller says who is asking and under which permissions, as for `applyCommit`: the service
 * computes the requester's access and hidden set from them (07 §4; ADR 0019) and keeps nothing.
 * A request the history rules refuse (`forbidden`, `not_found`, `conflict`, `workflow_active`) is
 * an answer, `{ refused: { code, reason } }`, not an error. The history rules are decisions, as a
 * room's rejection is.
 */
import {
  type HiddenSet,
  type Preconditions,
  type StepJson,
  computeAccess,
  contentAt,
  hiddenSet,
  regionInfos,
  stateVisible,
} from '@docedit/authority';
import {
  AttributionMap,
  type AttributionResult,
  type Comparison,
  type Granularity,
  type HistoryGate,
  attributionAt,
  commitAuthor,
  compare,
  indexDocument,
  planRestore,
} from '@docedit/history';
import { type JsonEnvelope, type JsonNode, canonicalEnvelope } from '@docedit/model';
import type { Node, Schema } from 'prosemirror-model';
import {
  type Answer,
  type HeldState,
  type WireAuthor,
  type WirePermissions,
  connectionOf,
  fail,
  unpackWirePerms,
} from './common.ts';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What every history call says about the asker (see the module comment). */
export interface HistoryView {
  requester: WireAuthor;
  permissions: WirePermissions;
  /** The history visibility gate (07 §8): the lowest seq visible, and the seqs of named versions. */
  gate?: { min?: number; named?: number[] };
  /** Unix milliseconds; the service's clock when absent. */
  now?: number;
}

export interface HistoryRefusal {
  refused: { code: string; reason: string };
}

export interface RestoreStepsRequest extends HistoryView {
  toSeq: number;
  /** A region identifier; absent for the whole document. */
  region?: string;
  dryRun?: boolean;
  /** Region identifiers retired for good (I3). */
  retired?: string[];
  /** Makes new identifiers deterministic, so that a dry run and its restore agree. */
  idSalt?: string;
}

export type RestoreStepsAnswer =
  | (({ kind: 'steps'; region: string; steps: StepJson[] } | RestoreSnapshot) & RestoreCommon)
  | HistoryRefusal;

interface RestoreSnapshot {
  kind: 'snapshot';
  reason: 'restore';
  region?: string;
  fallback?: 'too_large';
  /** The content the snapshot commit holds. */
  content: JsonEnvelope;
}

interface RestoreCommon {
  toSeq: number;
  headSeq: number;
  reidentified: Record<string, string>;
  recreated: string[];
  replaced: string[];
  /** What the room checks again when it applies the commit (04 §5). */
  preconditions: Preconditions;
  /** Nothing differs: the caller need not commit anything. */
  unchanged: boolean;
  dryRun?: Comparison;
}

export interface DiffRequest extends HistoryView {
  fromSeq: number;
  toSeq: number;
  region?: string;
  granularity?: Granularity;
}

export type DiffAnswer = { comparison: Comparison } | HistoryRefusal;

export interface AttributionRequest extends HistoryView {
  /** The state at this seq; the head when absent. */
  seq?: number;
  /** Only the blocks of this region. */
  region?: string;
  /** Only these blocks, by identifier. */
  blocks?: string[];
}

export interface AttributedRun {
  /** The position of the first character of the run, in the document at `seq`. */
  from: number;
  len: number;
  user: string;
  /** The commit that inserted the content (0: the content the document was created with). */
  seq: number;
  agent?: string;
  restoredBy?: string;
  restoredSeq?: number;
}

export interface AttributedBlock {
  id: string;
  type: string;
  region: string | null;
  /** The positions the block covers (its start and end). */
  from: number;
  to: number;
  runs: AttributedRun[];
}

export type AttributionAnswer = { seq: number; blocks: AttributedBlock[] } | HistoryRefusal;

// --- Parsing -------------------------------------------------------------------------------------

function parseView(input: unknown): Answer<{ view: HistoryView }> {
  const bad = (m: string) => fail('invalid_request', m);
  if (!isObject(input)) return bad('the request must be a JSON object');
  const author = input['requester'];
  if (
    !isObject(author) ||
    typeof author['sub'] !== 'string' ||
    typeof author['session'] !== 'string' ||
    typeof author['role'] !== 'string'
  )
    return bad('requester needs a sub, a session and a role');
  const perms = input['permissions'];
  if (!isObject(perms)) return bad('permissions must be an object');
  if (typeof perms['revision'] !== 'number' || !Number.isSafeInteger(perms['revision']))
    return bad('permissions.revision must be an integer');
  if (!Array.isArray(perms['grants'])) return bad('permissions.grants must be an array');
  const gate = input['gate'];
  if (gate !== undefined) {
    if (!isObject(gate)) return bad('gate must be an object');
    if (gate['min'] !== undefined && !Number.isSafeInteger(gate['min']))
      return bad('gate.min must be an integer');
    if (
      gate['named'] !== undefined &&
      !(Array.isArray(gate['named']) && gate['named'].every((n) => Number.isSafeInteger(n)))
    )
      return bad('gate.named must be an array of integers');
  }
  if (input['now'] !== undefined && !Number.isSafeInteger(input['now']))
    return bad('now must be an integer');
  return { ok: true, view: input as unknown as HistoryView };
}

// --- Shared pieces -------------------------------------------------------------------------------

interface Asker {
  conn: ReturnType<typeof connectionOf>;
  perms: ReturnType<typeof unpackWirePerms>;
  gate: HistoryGate;
  now: number;
}

function askerOf(view: HistoryView, state: HeldState): Asker {
  const named = new Set(view.gate?.named ?? []);
  return {
    conn: connectionOf(view.requester),
    perms: unpackWirePerms(view.permissions),
    gate: { min: view.gate?.min ?? 0, head: state.head, named: (seq) => named.has(seq) },
    now: view.now ?? Date.now(),
  };
}

/** The document at `seq`, or undefined when the state does not reach it. */
function nodeAt(state: HeldState, seq: number): Node | undefined {
  if (!Number.isSafeInteger(seq) || seq < state.first || seq > state.head) return undefined;
  if (seq === state.head) return state.headDoc;
  const r = contentAt(seq, state.source);
  return r.ok ? r.doc : undefined;
}

/** What the asker may not see in any of these documents (ADR 0019). */
function hiddenIn(asker: Asker, ...docs: Node[]): HiddenSet {
  const regions = new Set<string>();
  const values = new Set<string>();
  let titles = true;
  for (const doc of docs) {
    const h = hiddenSet(asker.conn, doc, asker.perms, asker.now);
    for (const r of h.regions) regions.add(r);
    for (const v of h.values) values.add(v);
    titles = titles && h.titles;
  }
  return { regions, values, titles: regions.size === 0 ? false : titles };
}

/** The attribution map at `seq`: the baseline at the checkpoint, replayed over the log. */
function mapAt(schema: Schema, state: HeldState, seq: number): AttributionResult {
  return attributionAt(seq, {
    schema,
    checkpoints: [{ seq: state.first, map: state.baseAttribution }],
    commits: (after, to) => state.log.filter((c) => c.seq > after && c.seq <= to),
    snapshot: (c) => {
      const node = state.snapshots.get(c.snapshot.checkpoint);
      return node ? AttributionMap.create(node.content.size, commitAuthor(c)) : undefined;
    },
  });
}

const refused = (code: string, reason: string): { ok: true } & HistoryRefusal => ({
  ok: true,
  refused: { code, reason },
});

// --- The calls -----------------------------------------------------------------------------------

/** `restoreSteps` (05 §10; 08 §8): the steps or the snapshot that restore a document or a region. */
export function restoreSteps(
  schema: Schema,
  state: HeldState,
  input: unknown,
): Answer<RestoreStepsAnswer> {
  const parsed = parseView(input);
  if (!parsed.ok) return parsed;
  const req = input as RestoreStepsRequest;
  if (typeof req.toSeq !== 'number' || !Number.isSafeInteger(req.toSeq))
    return fail('invalid_request', 'toSeq must be an integer');
  if (req.region !== undefined && typeof req.region !== 'string')
    return fail('invalid_request', 'region must be a string');
  if (req.retired !== undefined && !(Array.isArray(req.retired) && req.retired.every(isString)))
    return fail('invalid_request', 'retired must be an array of strings');
  const asker = askerOf(parsed.view, state);
  const target = nodeAt(state, req.toSeq);
  // A seq the state was not opened far enough back to read is not a refusal of the history rules:
  // the caller must open the state from an earlier checkpoint.
  if (target === undefined && req.toSeq >= 0 && req.toSeq <= state.head)
    return fail('not_found', `the state was opened from a checkpoint at ${state.first}`, {
      seq: req.toSeq,
    });
  const targetDoc = target ?? state.headDoc;
  const access = computeAccess(asker.conn, regionInfos(state.headDoc), asker.perms, asker.now);
  const headMap = mapAt(schema, state, state.head);
  const targetMap = target ? mapAt(schema, state, req.toSeq) : undefined;
  const planned = planRestore(
    {
      toSeq: req.toSeq,
      ...(req.region !== undefined ? { region: req.region } : {}),
      ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
    },
    {
      schema,
      head: {
        seq: state.head,
        doc: state.headDoc,
        ...(headMap.ok ? { attribution: headMap.map } : {}),
      },
      target: (seq) =>
        seq === req.toSeq
          ? { doc: targetDoc, ...(targetMap?.ok ? { attribution: targetMap.map } : {}) }
          : undefined,
      gate: asker.gate,
      hidden: hiddenIn(asker, state.headDoc, targetDoc),
      access,
      user: asker.conn.sub,
      regionStates: asker.perms.regionStates,
      leasedToSomeoneElse: (region) =>
        asker.perms.leases.some(
          (l) => l.region === region && l.holder !== asker.conn.sub && l.expiresAt > asker.now,
        ),
      workflowActive: asker.perms.workflowActive,
      ...(req.retired ? { retired: new Set(req.retired) } : {}),
      ...(req.idSalt !== undefined ? { idSalt: req.idSalt } : {}),
    },
  );
  if (!planned.ok) return refused(planned.code, planned.reason);
  const plan = planned.plan;
  const common: RestoreCommon = {
    toSeq: req.toSeq,
    headSeq: state.head,
    reidentified: plan.reidentified,
    recreated: plan.recreated,
    replaced: plan.replaced,
    preconditions: plan.preconditions,
    unchanged: plan.unchanged,
    ...(plan.dryRun ? { dryRun: plan.dryRun } : {}),
  };
  if (plan.kind === 'steps')
    return { ok: true, kind: 'steps', region: plan.region, steps: plan.stepsJson, ...common };
  const content = canonicalEnvelope({
    cdm: state.cdm,
    requires: state.requires.get(state.head) ?? [],
    doc: plan.result.toJSON() as JsonNode,
  });
  return {
    ok: true,
    kind: 'snapshot',
    reason: plan.reason,
    ...(plan.region !== undefined ? { region: plan.region } : {}),
    ...(plan.fallback !== undefined ? { fallback: plan.fallback } : {}),
    content,
    ...common,
  };
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** `diff` (05 §10; 08 §6): the comparison of two states, as the asker may see it. */
export function diff(schema: Schema, state: HeldState, input: unknown): Answer<DiffAnswer> {
  const parsed = parseView(input);
  if (!parsed.ok) return parsed;
  const req = input as DiffRequest;
  if (!Number.isSafeInteger(req.fromSeq) || !Number.isSafeInteger(req.toSeq))
    return fail('invalid_request', 'fromSeq and toSeq must be integers');
  if (req.granularity !== undefined && req.granularity !== 'word' && req.granularity !== 'char')
    return fail('invalid_request', 'granularity must be word or char');
  if (req.region !== undefined && typeof req.region !== 'string')
    return fail('invalid_request', 'region must be a string');
  if (req.fromSeq < state.first && req.fromSeq >= 0 && req.fromSeq <= state.head)
    return fail('not_found', `the state was opened from a checkpoint at ${state.first}`, {
      seq: req.fromSeq,
    });
  const asker = askerOf(parsed.view, state);
  const from = nodeAt(state, req.fromSeq);
  const to = nodeAt(state, req.toSeq);
  const hidden = hiddenIn(asker, ...[state.headDoc, from, to].filter((d): d is Node => !!d));
  const result = compare(
    {
      fromSeq: req.fromSeq,
      toSeq: req.toSeq,
      ...(req.region !== undefined ? { region: req.region } : {}),
      ...(req.granularity !== undefined ? { granularity: req.granularity } : {}),
    },
    {
      schema,
      incarnation: state.stateId,
      content: (seq) => nodeAt(state, seq),
      commits: (after, upTo) => state.log.filter((c) => c.seq > after && c.seq <= upTo),
      attribution: (seq) => {
        const m = mapAt(schema, state, seq);
        return m.ok ? m.map : undefined;
      },
      scopeIndex: (scope, after, upTo) => {
        for (let i = state.log.length - 1; i >= 0; i--) {
          const c = state.log[i]!;
          if (c.seq > upTo) continue;
          if (c.seq <= after) break;
          if (c.scopes.includes(scope)) return commitAuthor(c);
        }
        return undefined;
      },
    },
    { gate: asker.gate, hidden },
  );
  if (!result.ok) return refused(result.code, result.reason);
  return { ok: true, comparison: result.comparison };
}

/** `attribution` (05 §10; 08 §7): who wrote which spans of a region or of some blocks. */
export function attribution(
  schema: Schema,
  state: HeldState,
  input: unknown,
): Answer<AttributionAnswer> {
  const parsed = parseView(input);
  if (!parsed.ok) return parsed;
  const req = input as AttributionRequest;
  const seq = req.seq ?? state.head;
  if (!Number.isSafeInteger(seq)) return fail('invalid_request', 'seq must be an integer');
  if (req.region !== undefined && typeof req.region !== 'string')
    return fail('invalid_request', 'region must be a string');
  if (req.blocks !== undefined && !(Array.isArray(req.blocks) && req.blocks.every(isString)))
    return fail('invalid_request', 'blocks must be an array of strings');
  if (seq > state.head) return refused('not_found', `no version at seq ${seq}`);
  const asker = askerOf(parsed.view, state);
  if (!stateVisible(asker.gate.min, seq, asker.gate.head, asker.gate.named))
    return refused('forbidden', `seq ${seq} is below your visibility gate`);
  const doc = nodeAt(state, seq);
  if (!doc)
    return fail('not_found', `the state was opened from a checkpoint at ${state.first}`, { seq });
  const hidden = hiddenIn(asker, doc);
  const index = indexDocument(doc);
  if (req.region !== undefined) {
    const exists = [...index.blocks.values()].some((b) => b.id === req.region);
    if (!exists || hidden.regions.has(req.region))
      return refused('not_found', `no region ${req.region}`);
  }
  const chosen = req.blocks
    ? req.blocks.map((id) => index.blocks.get(id))
    : index.order.filter((b) => b.leaf && (req.region === undefined || b.region === req.region));
  const out: AttributedBlock[] = [];
  const m = mapAt(schema, state, seq);
  if (!m.ok) return fail('replay_failed', m.reason);
  for (const [i, b] of chosen.entries()) {
    if (!b || (b.region !== null && hidden.regions.has(b.region)))
      return refused('not_found', `no block ${req.blocks?.[i] ?? '?'}`);
    const from = b.pos;
    const to = b.pos + b.node.nodeSize;
    out.push({
      id: b.id,
      type: b.type,
      region: b.region,
      from,
      to,
      runs: m.map
        .slice(from, to)
        .map(({ from: f, len, ...author }) => ({ from: f, len, ...author })),
    });
  }
  return { ok: true, seq, blocks: out };
}
