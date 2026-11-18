/**
 * The attribution map a room keeps (08 §7; HIS-014; ADR 0377). The room host holds one tracker next
 * to the room. It applies each stored steps commit to the map in order, so that every existing run
 * is mapped through the commit's position map and the inserted content gets a run naming the
 * commit's user and `seq`. A snapshot commit replaces the map with one run of its user and `seq`.
 *
 * The tracker mirrors what the checkpointer replays: a map at the last checkpoint (`base`) and the
 * commits stored since, so that the map at the `seq` of a checkpoint is known whichever commits are
 * stored after it. A map is saved with each checkpoint, and a room that opens takes the map of the
 * checkpoint it opens from and replays the commits after it. Without a saved map (a checkpoint
 * written before this change) the map is rebuilt by one replay from seq 0.
 *
 * The map is only the author of each position. Formatting, attribute changes and control commits
 * leave it as it is (`applyCommit`, `@docedit/history`).
 */
import { AttributionMap, applyCommit, attributionAt, type AttributionJson } from '@docedit/history';
import type { LogCommit, SnapshotCommit } from '@docedit/authority';
import type { cdmSchema } from '@docedit/model/prosemirror';
import type { DocRef, DocumentRecord, LogStore } from '../storage/types.ts';
import type { Checkpointer } from './checkpoints.ts';

type Schema = ReturnType<typeof cdmSchema>;

export class AttributionTracker {
  readonly #schema: Schema;
  #base: AttributionMap;
  #baseSeq: number;
  #head: AttributionMap;
  #headSeq: number;
  #since: LogCommit[] = [];
  #broken: string | null = null;

  constructor(schema: Schema, map: AttributionMap, seq: number) {
    this.#schema = schema;
    this.#base = map;
    this.#baseSeq = seq;
    this.#head = map.clone();
    this.#headSeq = seq;
  }

  /** The `seq` the map is at. */
  get seq(): number {
    return this.#headSeq;
  }

  /** Why the map can no longer be kept (a gap in the commits it was given), or null. */
  get broken(): string | null {
    return this.#broken;
  }

  /** A copy of the map at the head, for readers. */
  snapshot(): AttributionMap {
    return this.#head.clone();
  }

  /**
   * Applies the next stored commit. A snapshot commit needs the size of its content. A commit
   * that is not the next one breaks the tracker, which then saves nothing.
   */
  apply(commit: LogCommit, snapshotSize?: () => number): void {
    if (this.#broken) return;
    if (commit.seq !== this.#headSeq + 1) {
      this.#broken = `commit ${commit.seq} follows ${this.#headSeq}`;
      return;
    }
    try {
      if (commit.kind === 'snapshot') {
        const size = snapshotSize?.();
        if (size === undefined) {
          this.#broken = `no size for the content of snapshot commit ${commit.seq}`;
          return;
        }
        this.#head = AttributionMap.create(size, { user: commit.user, seq: commit.seq });
        // A snapshot restarts the replay: its map is the new base.
        this.#base = this.#head.clone();
        this.#baseSeq = commit.seq;
        this.#since = [];
      } else {
        applyCommit(this.#head, commit, this.#schema);
        this.#since.push(commit);
      }
      this.#headSeq = commit.seq;
    } catch (e) {
      this.#broken = `commit ${commit.seq}: ${(e as Error).message}`;
    }
  }

  /** The map at `seq`, between the last checkpoint and the head; null when it cannot be known. */
  mapAt(seq: number): AttributionMap | null {
    if (this.#broken || seq < this.#baseSeq || seq > this.#headSeq) return null;
    if (seq === this.#headSeq) return this.#head.clone();
    const map = this.#base.clone();
    try {
      for (const c of this.#since) {
        if (c.seq > seq) break;
        applyCommit(map, c, this.#schema);
      }
    } catch {
      return null;
    }
    return map;
  }

  /** The serial form of the map at `seq`, as saved with a checkpoint, or null. */
  jsonAt(seq: number): AttributionJson | null {
    return this.mapAt(seq)?.toJSON() ?? null;
  }

  /** A checkpoint at `seq` is stored: replay from it from now on. */
  advance(seq: number): void {
    if (this.#broken || seq <= this.#baseSeq || seq > this.#headSeq) return;
    const map = this.mapAt(seq);
    if (!map) return;
    this.#base = map;
    this.#baseSeq = seq;
    this.#since = this.#since.filter((c) => c.seq > seq);
  }
}

/** The size, in positions, of the content of a snapshot commit. */
export type SnapshotSize = (c: SnapshotCommit) => number | Promise<number>;

export interface OpenAttribution {
  ref: DocRef;
  record: Pick<DocumentRecord, 'createdBy'>;
  schema: Schema;
  checkpointer: Checkpointer;
  logs: Pick<LogStore, 'read'>;
  /** The checkpoint the room opens from: its seq and the size of its content (BE-019 opens a large one without an envelope). */
  checkpoint: { seq: number; size: number };
  /** The commits after the checkpoint, in order. */
  log: readonly LogCommit[];
  /** The size of the content of a snapshot commit, at any seq up to the head. */
  snapshotSize: SnapshotSize;
  /** Called when a saved map was refused or a replay was needed. */
  note?: (what: string) => void;
}

/** The size of a document given as JSON, in positions. */
export function contentSizeOf(schema: Schema, doc: unknown): number {
  return schema.nodeFromJSON(doc).content.size;
}

/**
 * The tracker of a room that opens from a checkpoint (ADR 0377): the saved map and a replay of the
 * commits after it; or, when none is saved (or the saved one does not fit the content), a replay
 * from seq 0 over the stored commits. Returns null when the map cannot be built; the room then
 * runs without one.
 */
export async function openAttribution(o: OpenAttribution): Promise<AttributionTracker | null> {
  const { checkpoint: cp } = o;
  const fits = (m: AttributionMap) => m.size === cp.size;
  let base: AttributionMap | null = null;
  if (cp.seq === 0) {
    base = AttributionMap.create(cp.size, {
      user: o.record.createdBy,
      seq: 0,
    });
  } else {
    const saved = await o.checkpointer.loadSide(o.ref, cp.seq);
    if (saved) {
      try {
        const m = AttributionMap.fromJSON(saved);
        if (fits(m)) base = m;
        else o.note?.(`the saved map at ${cp.seq} does not fit its content`);
      } catch (e) {
        o.note?.(`the saved map at ${cp.seq} is unreadable: ${(e as Error).message}`);
      }
    }
    base ??= await replayFromStart(o, cp.seq);
    if (!base || !fits(base)) return null;
  }
  const tracker = new AttributionTracker(o.schema, base, cp.seq);
  for (const c of o.log) {
    const size = c.kind === 'snapshot' ? await o.snapshotSize(c) : undefined;
    tracker.apply(c, size === undefined ? undefined : () => size);
  }
  return tracker.broken ? null : tracker;
}

/** The map at `seq`, replayed from the content at seq 0 over the stored commits (the backfill). */
export async function replayFromStart(
  o: Pick<
    OpenAttribution,
    'ref' | 'record' | 'schema' | 'checkpointer' | 'logs' | 'snapshotSize' | 'note'
  >,
  seq: number,
): Promise<AttributionMap | null> {
  const zero = await o.checkpointer.load(o.ref, 0);
  if (!zero || zero.seq !== 0) return null;
  const map0 = AttributionMap.create(contentSizeOf(o.schema, zero.envelope.doc), {
    user: o.record.createdBy,
    seq: 0,
  });
  const commits = seq > 0 ? await o.logs.read(o.ref, 1, seq) : [];
  const snapshots = new Map<number, AttributionMap>();
  for (const c of commits)
    if (c.kind === 'snapshot')
      snapshots.set(
        c.seq,
        AttributionMap.create(await o.snapshotSize(c), { user: c.user, seq: c.seq }),
      );
  const r = attributionAt(seq, {
    schema: o.schema,
    checkpoints: [{ seq: 0, map: map0 }],
    commits: (after, to) => commits.filter((c) => c.seq > after && c.seq <= to),
    snapshot: (c) => snapshots.get(c.seq),
  });
  if (!r.ok) {
    o.note?.(`the attribution map could not be replayed: ${r.reason}`);
    return null;
  }
  o.note?.(`the attribution map at ${seq} was rebuilt from seq 0 (${r.replayed} commits)`);
  return r.map;
}
