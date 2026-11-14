/**
 * In-memory log storage with the conditions of 04 §5 step 9 and injectable faults (SPK-016,
 * SYN-016). A write is conditional on the ownership epoch, on the primary key (document, seq), and
 * on the grants revision it was checked against still being current (G7). A commit identifier that
 * is already stored is reported as `duplicate` with the stored commit (04 §5: a conflict on the
 * identifier alone is a duplicate, never another writer).
 *
 * services/document-service/test/postgres/convergence.pg.test.ts replaces this class through
 * vi.mock with its PostgreSQL storage, so the members the simulation uses (the constructor,
 * `log`, `perms`, `epoch`, `permsHistory`, `incarnation`, `initial`, `requires`,
 * `initialRevision`, `writes`, `write`, `changePermissions`, `claimOwnership`) keep their names
 * and signatures. `checkpoints` serves only the snapshot runs, which use this class alone.
 */
import type { Node } from 'prosemirror-model';
import type { PermissionState } from '../../src/permissions/model.ts';
import type { LogCommit, SnapshotCommit, WriteRequest, WriteResult } from '../../src/room/types.ts';

export type Fault = 'none' | 'fail' | 'unknown-applied' | 'unknown-lost';

export class MemoryStorage {
  readonly log: LogCommit[] = [];
  readonly permsHistory = new Map<number, PermissionState>();
  epoch = 1;
  perms: PermissionState;
  incarnation = 'inc-1';
  writes = 0;
  readonly initial: Node;
  readonly requires: readonly string[];
  /** Checkpoints by reference: the object storage of a snapshot commit's content (08 §3). */
  readonly checkpoints = new Map<string, Node>();

  /** The grants revision in force when the document was created (sequence number 0). */
  readonly initialRevision: number;

  constructor(initial: Node, requires: readonly string[], perms: PermissionState) {
    this.initial = initial;
    this.requires = requires;
    this.perms = perms;
    this.initialRevision = perms.revision;
    this.permsHistory.set(perms.revision, perms);
  }

  write(req: WriteRequest, fault: Fault): WriteResult {
    this.writes++;
    if (req.epoch !== this.epoch) return { status: 'fenced' };
    if (req.fromSeq !== this.log.length + 1) return { status: 'fenced' };
    if (req.revision !== this.perms.revision)
      return { status: 'revision_moved', perms: this.perms };
    const commits: LogCommit[] = req.snapshot ? [req.snapshot] : req.commits;
    for (const c of commits) {
      const stored = this.log.find((x) => x.id === c.id);
      if (stored) return { status: 'duplicate', stored };
    }
    switch (fault) {
      case 'none':
        this.log.push(...commits);
        return { status: 'ok' };
      case 'fail':
        return { status: 'failed' };
      case 'unknown-applied':
        this.log.push(...commits);
        return { status: 'unknown', tail: this.log.slice(req.fromSeq - 1) };
      case 'unknown-lost':
        return { status: 'unknown', tail: this.log.slice(req.fromSeq - 1) };
    }
  }

  /** The control plane changes grants, states or leases: a new revision in one transaction (07 §9). */
  changePermissions(f: (p: PermissionState) => Omit<PermissionState, 'revision'>): PermissionState {
    const next: PermissionState = { ...f(this.perms), revision: this.perms.revision + 1 };
    this.perms = next;
    this.permsHistory.set(next.revision, next);
    return next;
  }

  /** A new room takes ownership (failover): earlier owners are fenced. */
  claimOwnership(): number {
    this.epoch++;
    return this.epoch;
  }

  /** The content of a stored snapshot commit's checkpoint. */
  snapshotContent(c: SnapshotCommit): Node {
    const doc = this.checkpoints.get(c.snapshot.checkpoint);
    if (!doc) throw new Error(`no checkpoint ${c.snapshot.checkpoint}`);
    return doc;
  }

  /**
   * The operator procedure after a recovery that lost commits (06 §8, §9; SYN-029): the log is cut
   * back to `seq` and given a new incarnation, so that clients holding the lost commits reload.
   */
  rewind(seq: number, incarnation: string): void {
    this.log.length = seq;
    this.incarnation = incarnation;
  }
}
