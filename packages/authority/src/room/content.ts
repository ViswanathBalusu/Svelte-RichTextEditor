/**
 * Content at any sequence number (08 §3; HIS-005; 05 §6.2 `GET …/content?seq`).
 *
 * The content at `seq` is rebuilt from the nearest checkpoint at or before it, or from a snapshot
 * commit's checkpoint when one lies in between, plus a replay of the commits up to `seq`. Every
 * input is plain data or a function the caller supplies, so the work can run in a worker thread
 * (04 §12; SYN-039) with no state of the room. The visibility gate is checked first, before any
 * work (HIS-024).
 *
 * A pinned read is immutable: it is cached by incarnation and `seq`, and its entity tag combines
 * the two (SYN-029).
 */
import type { Node, Schema } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { applySteps } from '../rebase.ts';
import { stateVisible } from './gate.ts';
import {
  ENGINE,
  type LogCommit,
  type SnapshotCommit,
  type StoredCommit,
  isSnapshot,
} from './types.ts';

/** A checkpoint: the document at one `seq`, from durable state (08 §3). */
export interface Checkpoint {
  seq: number;
  doc: Node;
}

/** Replays one stored step or control commit onto a document, or returns why it cannot. */
export type Replayer = (doc: Node, commit: StoredCommit) => Node | string;

/** The key replayers are registered under: the engine and the CDM major version of a commit. */
export function replayerKey(engine: string, cdm: number): string {
  return `${engine}|cdm ${cdm}`;
}

/** The replayer of `pm-steps/1` for CDM 1: the pinned prosemirror-transform (04 §4). */
export function pmStepsReplayer(schema: Schema): Replayer {
  return (doc, commit) => {
    let steps: Step[];
    try {
      steps = commit.steps.map((s) => Step.fromJSON(schema, s));
    } catch (e) {
      return `commit ${commit.seq} has a step that does not parse: ${(e as Error).message}`;
    }
    const r = applySteps(doc, steps);
    return r.ok ? r.value.doc : `commit ${commit.seq} does not replay: ${r.reason}`;
  };
}

export interface ContentSource {
  incarnation: string;
  /** The current head. */
  head: number;
  /** Checkpoints at or below the head, in any order; seq 0 (the created content) among them. */
  checkpoints: readonly Checkpoint[];
  /** The commits after a sequence number up to another, in order, from storage. */
  commits: (afterSeq: number, toSeq: number) => readonly LogCommit[];
  /** The content of a snapshot commit's checkpoint. */
  resolve: (c: SnapshotCommit) => Node;
  /**
   * Replayers by `replayerKey(engine, cdm)`, so that commits made under an older engine or schema
   * replay with the package that made them (08 §15; HIS-045 sets how long one is kept).
   */
  replayers: ReadonlyMap<string, Replayer>;
}

/** The caller's visibility gate (HIS-024): `minVisibleSeq` and, in phase 2, named versions. */
export interface ContentGate {
  min: number;
  named?: (seq: number) => boolean;
}

export type ContentResult =
  | {
      ok: true;
      seq: number;
      incarnation: string;
      doc: Node;
      /** Where the rebuild started: a checkpoint or a snapshot commit's checkpoint. */
      from: { seq: number; kind: 'checkpoint' | 'snapshot' };
      /** Commits replayed after the start (target at most 2,000, 08 §3). */
      replayed: number;
    }
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; reason: string };

/** The content at `seq` (HIS-005). */
export function contentAt(seq: number, source: ContentSource, gate?: ContentGate): ContentResult {
  // The gate comes first: a refused read does no work (HIS-005 criterion 6).
  if (gate && !stateVisible(gate.min, seq, source.head, gate.named))
    return { ok: false, code: 'forbidden', reason: `seq ${seq} is below your visibility gate` };
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > source.head)
    return {
      ok: false,
      code: 'not_found',
      reason: `no content at seq ${seq} (head ${source.head})`,
    };
  let start: Checkpoint | undefined;
  for (const c of source.checkpoints) if (c.seq <= seq && (!start || c.seq > start.seq)) start = c;
  if (!start) return { ok: false, code: 'internal', reason: `no checkpoint at or before ${seq}` };
  const commits = source.commits(start.seq, seq);
  // A snapshot commit after the checkpoint replaces the document: start from its checkpoint.
  let from: { seq: number; kind: 'checkpoint' | 'snapshot' } = {
    seq: start.seq,
    kind: 'checkpoint',
  };
  let first = 0;
  for (let i = commits.length - 1; i >= 0; i--) {
    if (isSnapshot(commits[i]!)) {
      from = { seq: commits[i]!.seq, kind: 'snapshot' };
      first = i;
      break;
    }
  }
  let doc: Node;
  if (from.kind === 'snapshot') {
    try {
      doc = source.resolve(commits[first] as SnapshotCommit);
    } catch (e) {
      return {
        ok: false,
        code: 'internal',
        reason: `snapshot ${from.seq}: ${(e as Error).message}`,
      };
    }
    first++;
  } else doc = start.doc;
  let expected = from.seq + 1;
  let replayed = 0;
  for (let i = first; i < commits.length; i++) {
    const c = commits[i]!;
    if (c.seq !== expected)
      return { ok: false, code: 'internal', reason: `the log has a gap at ${expected}` };
    expected++;
    if (isSnapshot(c)) continue; // only the last one can be met here, and it was the start
    const replay = source.replayers.get(replayerKey(c.engine, c.cdm));
    if (!replay)
      return {
        ok: false,
        code: 'internal',
        reason: `no replayer for engine ${c.engine} and CDM ${c.cdm} (commit ${c.seq})`,
      };
    const next = replay(doc, c);
    if (typeof next === 'string') return { ok: false, code: 'internal', reason: next };
    doc = next;
    replayed++;
  }
  if (expected !== seq + 1)
    return { ok: false, code: 'internal', reason: `the log ends at ${expected - 1}, not ${seq}` };
  return { ok: true, seq, incarnation: source.incarnation, doc, from, replayed };
}

/** The default replayers: `pm-steps/1` with CDM 1. */
export function defaultReplayers(schema: Schema): Map<string, Replayer> {
  return new Map([[replayerKey(ENGINE, 1), pmStepsReplayer(schema)]]);
}

/** The entity tag of a pinned read: incarnation and `seq` together (SYN-029, HIS-005). */
export function contentEtag(incarnation: string, seq: number): string {
  return `"${incarnation}:${seq}"`;
}

/**
 * Rebuilt versions, cached by incarnation and `seq` (08 §3). A pinned read never changes, so an
 * entry never goes stale; the oldest is dropped when the cache is full.
 */
export class ContentCache {
  private readonly entries = new Map<string, Node>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!(capacity > 0)) throw new RangeError('a cache needs room for one entry');
    this.capacity = capacity;
  }

  private static key(incarnation: string, seq: number): string {
    return `${incarnation}\u0000${seq}`;
  }

  get(incarnation: string, seq: number): Node | undefined {
    const k = ContentCache.key(incarnation, seq);
    const hit = this.entries.get(k);
    if (hit) {
      // Most recently used last.
      this.entries.delete(k);
      this.entries.set(k, hit);
    }
    return hit;
  }

  set(incarnation: string, seq: number, doc: Node): void {
    const k = ContentCache.key(incarnation, seq);
    this.entries.delete(k);
    this.entries.set(k, doc);
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }

  /** The content at `seq`, from the cache or rebuilt and cached. */
  read(seq: number, source: ContentSource, gate?: ContentGate): ContentResult {
    if (gate && !stateVisible(gate.min, seq, source.head, gate.named))
      return { ok: false, code: 'forbidden', reason: `seq ${seq} is below your visibility gate` };
    const hit = this.get(source.incarnation, seq);
    if (hit)
      return {
        ok: true,
        seq,
        incarnation: source.incarnation,
        doc: hit,
        from: { seq, kind: 'checkpoint' },
        replayed: 0,
      };
    const r = contentAt(seq, source);
    if (r.ok) this.set(source.incarnation, seq, r.doc);
    return r;
  }
}
