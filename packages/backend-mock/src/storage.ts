/**
 * In-memory log storage for one segment of a document (04 §5 step 9). A write is conditional on the
 * ownership epoch, on the primary key (document, seq) and on the grants revision it was checked
 * against still being current (G7), exactly as the authority's WriteRequest expects.
 */
import type { PermissionState, StoredCommit, WriteRequest, WriteResult } from '@docedit/authority';

export class MemoryLog {
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
