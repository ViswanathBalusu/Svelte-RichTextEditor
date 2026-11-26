/**
 * Recovery by evidence (06 §8, §9, §11; 08 §12; BE-078, BE-081). Everything here runs against the
 * stores alone, with no service running: a database dump restored somewhere and the object store
 * are enough.
 *
 * - `rebuild` replays a document to a `seq` from the newest usable checkpoint at or before it and
 *   the log, and gives the SHA-256 of the canonical form (the hash `sync.check` carries).
 * - `verifyCheckpoint` compares a stored checkpoint with a replay from an earlier one (or from the
 *   content at 0); the room's checkpoints are written from the durable state, so a mismatch means
 *   corruption (BE-020 criterion 5, before older checkpoints are thinned).
 * - `affected` and `newIncarnation` are the operator procedure after a database recovery: the
 *   documents whose checkpoints or cold segments reach past the restored head get a new
 *   incarnation, an audit event, and those checkpoints and segments set aside, so that every
 *   client reloads.
 */
import { randomUUID } from 'node:crypto';
import { isSnapshot, type LogCommit } from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import type { SegmentRange, SegmentStore } from '../objects/segments.ts';
import type { Pool } from '../storage/db.ts';
import type {
  AuditStore,
  CheckpointIndex,
  CheckpointStore,
  DocRef,
  LogStore,
} from '../storage/types.ts';
import { Checkpointer, type LoadedCheckpoint } from './checkpoints.ts';
import { checkpoint as replayEncode, encode, type Base } from './tasks.ts';
import { Workers } from './workers.ts';

export interface RecoveryStores {
  logs: LogStore;
  checkpoints: CheckpointStore;
  index?: CheckpointIndex | undefined;
  audit?: AuditStore | undefined;
  /** Cold segments in the object store (HIS-029); absent: none are listed or set aside. */
  segments?: SegmentStore | undefined;
}

export interface Rebuilt {
  seq: number;
  /** SHA-256 of the canonical form, lower-case hex. */
  hash: string;
  /** The checkpoint the replay started from. */
  from: number;
  /** Commits replayed. */
  replayed: number;
}

function checkpointer(s: RecoveryStores): Checkpointer {
  return new Checkpointer({
    store: s.checkpoints,
    index: s.index,
    workers: new Workers({ size: 0, timeoutMs: 60_000 }),
  });
}

/** Replays `log` (the commits after `cp`) onto `cp`; a snapshot commit restarts from its content. */
async function replayFrom(
  s: RecoveryStores,
  ref: DocRef,
  cp: LoadedCheckpoint,
  log: readonly LogCommit[],
): Promise<{ hash: string; replayed: number }> {
  let base: Base = cp.base;
  let commits: LogCommit[] = [...log];
  for (let i = log.length - 1; i >= 0; i--) {
    const c = log[i]!;
    if (!isSnapshot(c)) continue;
    const json = s.logs.snapshotContent ? await s.logs.snapshotContent(ref, c.seq) : null;
    if (!json) throw new Error(`snapshot commit ${c.seq} has no content`);
    base = { doc: json.doc };
    commits = log.slice(i + 1);
    break;
  }
  const e = replayEncode({
    base,
    cdm: cp.envelope.cdm,
    requires: cp.envelope.requires,
    commits: commits.map((c) => (isSnapshot(c) ? [] : c.steps)),
  });
  return { hash: e.hash, replayed: log.length };
}

/** BE-081 criterion 1: the canonical hash of the document at `seq` (default: the head). */
export async function rebuild(s: RecoveryStores, ref: DocRef, seq?: number): Promise<Rebuilt> {
  const head = await s.logs.head(ref);
  const at = seq ?? head.seq;
  if (!Number.isSafeInteger(at) || at < 0 || at > head.seq)
    throw new RangeError(`seq ${at} is not between 0 and the head ${head.seq}`);
  const cp = await checkpointer(s).load(ref, at);
  if (!cp) throw new Error('the document has no checkpoint at or before the seq, not even at 0');
  const log = cp.seq < at ? await s.logs.read(ref, cp.seq + 1, at) : [];
  if (log.length !== at - cp.seq) throw new Error(`the log has a gap between ${cp.seq} and ${at}`);
  const r = await replayFrom(s, ref, cp, log);
  return { seq: at, hash: r.hash, from: cp.seq, replayed: r.replayed };
}

export interface CheckpointVerdict {
  seq: number;
  ok: boolean;
  /** The hash of the stored checkpoint's canonical form. */
  stored: string;
  /** The hash of the replay from `from`. */
  replayed: string;
  from: number;
}

/**
 * BE-081 criterion 3 (and BE-020 criterion 5): the checkpoint at `seq` against a replay of the log
 * from the newest earlier checkpoint, or from the content at 0.
 */
export async function verifyCheckpoint(
  s: RecoveryStores,
  ref: DocRef,
  seq: number,
): Promise<CheckpointVerdict> {
  const stored = await s.checkpoints.get(ref, seq);
  if (!stored) throw new Error(`no checkpoint at ${seq}`);
  const storedHash = encode({ envelope: stored }).hash;
  const earlier = seq > 0 ? await checkpointer(s).load(ref, seq - 1) : null;
  if (!earlier) return { seq, ok: true, stored: storedHash, replayed: storedHash, from: seq };
  const log = await s.logs.read(ref, earlier.seq + 1, seq);
  if (log.length !== seq - earlier.seq) throw new Error(`the log has a gap below ${seq}`);
  const r = await replayFrom(s, ref, earlier, log);
  return {
    seq,
    ok: r.hash === storedHash,
    stored: storedHash,
    replayed: r.hash,
    from: earlier.seq,
  };
}

export interface ThinningGate {
  /** True only when the checkpoint's hash matched a replay of the log. */
  proceed: boolean;
  verdict: CheckpointVerdict;
}

/**
 * BE-020 criterion 5: the gate that thinning (HIS-030) must pass before older checkpoints are
 * removed for the one at `seq`. The checkpoint is compared with a replay of the log; on a match
 * thinning may proceed, on a mismatch it may not and `alert` is called (with the metric counter,
 * `dep_checkpoint_mismatches_total`, an operator's alert rule reads). A checkpoint that cannot be
 * verified (missing, or a gap in the log) does not pass either: the error is passed on and
 * nothing is thinned.
 */
export async function gateThinning(
  s: RecoveryStores,
  ref: DocRef,
  seq: number,
  alert: (verdict: CheckpointVerdict, ref: DocRef) => void | Promise<void>,
): Promise<ThinningGate> {
  const verdict = await verifyCheckpoint(s, ref, seq);
  if (!verdict.ok) await alert(verdict, ref);
  return { proceed: verdict.ok, verdict };
}

export interface Affected {
  tenant: string;
  doc: string;
  head: number;
  /** The newest checkpoint beyond the head; null when only segments reach past it. */
  checkpoint: number | null;
  /** The cold segments whose range ends past the head; absent when there are none. */
  segments?: SegmentRange[];
}

/**
 * BE-078 criterion 1 (the dry run): every document whose recorded checkpoints reach past its head,
 * which is what a database restored to an earlier point leaves (the object store kept the newer
 * checkpoints). Reads across tenants through docedit_checkpoints_beyond_head().
 */
export async function affected(pool: Pool): Promise<Affected[]> {
  const r = await pool.query<{
    tenant_id: string;
    doc_id: string;
    head_seq: string;
    checkpoint_seq: string;
  }>('SELECT * FROM docedit_checkpoints_beyond_head()');
  return r.rows.map((x) => ({
    tenant: x.tenant_id,
    doc: x.doc_id,
    head: Number(x.head_seq),
    checkpoint: Number(x.checkpoint_seq),
  }));
}

/**
 * The selection of BE-078 criterion 1 over PostgreSQL and the object store: the documents of
 * `affected` (checkpoints past the head), and the documents with a cold segment whose range ends
 * past the head. The restored database cannot name those segments, so the object store is listed
 * (one listing of the whole store, then the head of each document that has a segment).
 */
export async function affectedWithSegments(
  pool: Pool,
  s: RecoveryStores & { segments: SegmentStore },
): Promise<Affected[]> {
  const byDoc = new Map<string, Affected>();
  for (const a of await affected(pool)) byDoc.set(`${a.tenant}/${a.doc}`, a);
  for (const ref of await s.segments.documents()) {
    const key = `${ref.tenant}/${ref.doc}`;
    const found = byDoc.get(key);
    const head = found ? found.head : await headOf(s, ref);
    if (head === null) continue;
    const segments = await s.segments.beyond(ref, head);
    if (segments.length === 0) continue;
    byDoc.set(key, {
      ...(found ?? { tenant: ref.tenant, doc: ref.doc, head, checkpoint: null }),
      segments,
    });
  }
  return [...byDoc.values()];
}

/** The head of a document, or null when the database has none (an object of a document it lost). */
async function headOf(s: RecoveryStores, ref: DocRef): Promise<number | null> {
  try {
    return (await s.logs.head(ref)).seq;
  } catch {
    return null;
  }
}

/** Whether the object store holds a checkpoint beyond the head (for stores without an index). */
export async function beyondHead(s: RecoveryStores, ref: DocRef): Promise<number | null> {
  return (await beyond(s, ref))?.checkpoint ?? null;
}

async function beyond(s: RecoveryStores, ref: DocRef): Promise<Affected | null> {
  const head = await s.logs.head(ref);
  const newest = await s.checkpoints.latest(ref, Number.MAX_SAFE_INTEGER);
  const segments = s.segments ? await s.segments.beyond(ref, head.seq) : [];
  const checkpoint = newest && newest.seq > head.seq ? newest.seq : null;
  if (checkpoint === null && segments.length === 0) return null;
  return {
    tenant: ref.tenant,
    doc: ref.doc,
    head: head.seq,
    checkpoint,
    ...(segments.length > 0 ? { segments } : {}),
  };
}

/**
 * The selection of BE-078 criterion 1 for stores without docedit_checkpoints_beyond_head(): the
 * documents among `refs` whose object store holds a checkpoint beyond their head, in the order
 * given. The others are not affected.
 */
export async function affectedAmong(
  s: RecoveryStores,
  refs: readonly DocRef[],
): Promise<Affected[]> {
  const out: Affected[] = [];
  for (const ref of refs) {
    const a = await beyond(s, ref);
    if (a) out.push(a);
  }
  return out;
}

export interface IncarnationChange {
  ref: DocRef;
  before: string;
  after: string;
  head: number;
  /** Checkpoints set aside: in the index, and in the object store when it can. */
  setAside: number[];
  /** Whether the object store set its copies aside too (it needs `setAside`). */
  objectsSetAside: boolean;
  /** Cold segments set aside in the object store (those whose range ended past the head). */
  segmentsSetAside: SegmentRange[];
}

export interface Incarnating extends LogStore {
  newIncarnation(ref: DocRef, incarnation: string): Promise<{ before: string }>;
}

/**
 * BE-078 criterion 2: gives a document a new incarnation, sets aside its checkpoints beyond the
 * head (in the index and the object store), and records an audit event. Every client that holds
 * a `seq` of the old incarnation then reloads (04 §9 step 3; SYN-029).
 */
export async function newIncarnation(
  s: RecoveryStores & { logs: Incarnating },
  ref: DocRef,
  opts: { actor?: string; now?: () => number } = {},
): Promise<IncarnationChange> {
  const head = (await s.logs.head(ref)).seq;
  const asideIndex = s.index ? await s.index.setAside(ref, head) : [];
  const asideObjects = s.checkpoints.setAside ? await s.checkpoints.setAside(ref, head) : [];
  const asideSegments = s.segments ? await s.segments.setAside(ref, head) : [];
  const after = randomUUID();
  const { before } = await s.logs.newIncarnation(ref, after);
  const setAside = [...new Set([...asideIndex, ...asideObjects])].sort((a, b) => a - b);
  await s.audit?.record([
    {
      id: uuid7(),
      tenant: ref.tenant,
      doc: ref.doc,
      actor: opts.actor ?? 'system',
      kind: 'incarnation.changed',
      data: {
        before,
        after,
        head,
        setAside,
        ...(asideSegments.length > 0 ? { segments: asideSegments } : {}),
      },
      at: (opts.now ?? Date.now)(),
    },
  ]);
  return {
    ref,
    before,
    after,
    head,
    setAside,
    objectsSetAside: s.checkpoints.setAside !== undefined,
    segmentsSetAside: asideSegments,
  };
}

/**
 * The `incarnation` command of recovery-cli.ts (BE-078 criteria 1, 2 and 4), given the selection
 * (`affected` over PostgreSQL, or `affectedAmong`). With `dryRun` it changes nothing and returns no
 * changes; otherwise it gives exactly the selected documents a new incarnation, one after the
 * other. A document that is not selected is not touched, so its incarnation is unchanged.
 */
export async function runIncarnation(
  s: RecoveryStores & { logs: Incarnating },
  selected: readonly Affected[],
  opts: { dryRun: boolean; actor?: string; now?: () => number },
): Promise<IncarnationChange[]> {
  if (opts.dryRun) return [];
  const changes: IncarnationChange[] = [];
  const by = {
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  for (const a of selected)
    changes.push(await newIncarnation(s, { tenant: a.tenant, doc: a.doc }, by));
  return changes;
}

/** The canonical hash of an envelope, as `sync.check` and the checkpoints compute it. */
export function contentHash(envelope: JsonEnvelope): string {
  return encode({ envelope }).hash;
}
