/**
 * In-memory log storage for one segment of a document (04 §5 step 9). A write is conditional on the
 * ownership epoch, on the primary key (document, seq) and on the grants revision it was checked
 * against still being current (G7), exactly as the authority's WriteRequest expects.
 */
import type { PermissionState, StoredCommit, WriteRequest, WriteResult } from '@docedit/authority';

export class MemoryLog implements SegmentLog {
  readonly commits: StoredCommit[] = [];
  readonly epoch = 1;
  /** The permission state of the document, as the database holds it. */
  perms: PermissionState;

  constructor(perms: PermissionState, seed: readonly StoredCommit[] = []) {
    this.perms = perms;
    this.commits.push(...seed);
  }

  write(req: WriteRequest, fail = false): WriteResult {
    if (req.epoch !== this.epoch) return { status: 'fenced' };
    if (req.fromSeq !== this.commits.length + 1) return { status: 'fenced' };
    if (req.revision !== this.perms.revision)
      return { status: 'revision_moved', perms: this.perms };
    if (fail) return { status: 'failed' };
    this.commits.push(...req.commits);
    return { status: 'ok' };
  }

  get head(): number {
    return this.commits.length;
  }
}

/** What `MockDocument` needs of the log of one segment; a write may finish later (PRO-100). */
export interface SegmentLog {
  readonly commits: StoredCommit[];
  readonly epoch: number;
  perms: PermissionState;
  readonly head: number;
  write(req: WriteRequest, fail?: boolean): WriteResult | Promise<WriteResult>;
}

/**
 * The log of a segment that a store holds (PRO-100). The checks of `MemoryLog` run first, against
 * what this process knows; then the store decides, because it sees the other writers. A commit
 * joins `commits` only once the store has it, so an acknowledgement means "stored".
 */
export class PersistedLog implements SegmentLog {
  readonly commits: StoredCommit[] = [];
  readonly epoch = 1;
  perms: PermissionState;
  private readonly remote: (req: WriteRequest) => Promise<WriteResult>;

  constructor(
    perms: PermissionState,
    seed: readonly StoredCommit[],
    remote: (req: WriteRequest) => Promise<WriteResult>,
  ) {
    this.perms = perms;
    this.commits.push(...seed);
    this.remote = remote;
  }

  write(req: WriteRequest, fail = false): WriteResult | Promise<WriteResult> {
    if (req.epoch !== this.epoch) return { status: 'fenced' };
    if (req.fromSeq !== this.commits.length + 1) return { status: 'fenced' };
    if (req.revision !== this.perms.revision)
      return { status: 'revision_moved', perms: this.perms };
    if (fail) return { status: 'failed' };
    return this.remote(req).then(
      (r) => {
        if (r.status === 'ok') this.commits.push(...req.commits);
        return r;
      },
      (): WriteResult => ({ status: 'failed' }),
    );
  }

  get head(): number {
    return this.commits.length;
  }
}
