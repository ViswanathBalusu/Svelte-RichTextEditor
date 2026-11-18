/**
 * What a persistent backend keeps of a document (PRO-100). The mock keeps everything in memory;
 * a backend that survives a reload (`@docedit/backend-local`) gives `MockDocument` a
 * `DocumentPersistence` and, on a later start, the `RestoredDocument` it read back. All of it is
 * plain JSON, so any store can hold it. Universal: no storage API is named here.
 */
import type {
  PermissionState,
  RegionApproval,
  RegionState,
  StoredCommit,
  WriteRequest,
  WriteResult,
  Lease,
  RegionGrant,
} from '@docedit/authority';

/** `PermissionState` as JSON: the maps become entry lists. */
export interface StoredPerms {
  revision: number;
  grants: RegionGrant[];
  regionStates: [string, RegionState][];
  leases: Lease[];
  documentState: PermissionState['documentState'];
  workflowActive: boolean;
  approvals?: [string, RegionApproval][];
}

export function packPerms(p: PermissionState): StoredPerms {
  const out: StoredPerms = {
    revision: p.revision,
    grants: p.grants.map((g) => ({ ...g })),
    regionStates: [...p.regionStates],
    leases: p.leases.map((l) => ({ ...l })),
    documentState: p.documentState,
    workflowActive: p.workflowActive,
  };
  if (p.approvals) out.approvals = [...p.approvals];
  return out;
}

export function unpackPerms(s: StoredPerms): PermissionState {
  const out: PermissionState = {
    revision: s.revision,
    grants: s.grants.map((g) => ({ ...g })),
    regionStates: new Map(s.regionStates),
    leases: s.leases.map((l) => ({ ...l })),
    documentState: s.documentState,
    workflowActive: s.workflowActive,
  };
  if (s.approvals) out.approvals = new Map(s.approvals);
  return out;
}

/** One segment of the log (04 §3.2): the content it starts from and the grants revision then. */
export interface SegmentRecord {
  /** External sequence number of the content: 0, or the number of the snapshot commit. */
  start: number;
  /** The grants revision in force at `start`. */
  revision: number;
  /** The document node as JSON (`Node.toJSON()`). */
  initial: unknown;
  requires: string[];
}

/** The document row: everything except the commits. */
export interface DocumentRecord {
  id: string;
  incarnation: string;
  perms: StoredPerms;
  segments: SegmentRecord[];
  /** External sequence number of the newest stored commit (or of the newest snapshot, when no commit follows). */
  head: number;
}

/** A stored commit with its external sequence number (`commit.seq` is relative to its segment). */
export interface StoredEntry {
  ext: number;
  commit: StoredCommit;
}

/** A document as read back from storage; `commits` are in external order. */
export interface RestoredDocument {
  record: DocumentRecord;
  commits: readonly StoredEntry[];
}

/**
 * The calls a document makes to its store. Every call is conditional on what the store holds, so
 * that two writers (two tabs) cannot both extend the same log: the loser is told `fenced`.
 */
export interface DocumentPersistence {
  /** Appends the commits of `req` to segment `segment` (04 §5 step 9); `offset` is the segment's start. */
  append(segment: number, offset: number, req: WriteRequest): Promise<WriteResult>;
  /** Adds the segment of a snapshot commit; false when the store's head is not `expectHead`. */
  addSegment(segment: SegmentRecord, expectHead: number): Promise<boolean>;
  /** Stores the permission state of the next revision (04 G7); false when the store holds another revision. */
  putPerms(perms: PermissionState): Promise<boolean>;
  /** A write found the store ahead of this document: it should read the store again. */
  stale(): void;
}
