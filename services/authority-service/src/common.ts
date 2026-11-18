/**
 * What the authority service's modules share: the shape of an answer, a held state, and the wire
 * form of the permissions and the author a call is judged under (05 §10). `service.ts` re-exports
 * them.
 */
import type {
  Connection,
  ContentSource,
  DocRole,
  DocumentState,
  LogCommit,
  PermissionState,
  RegionApproval,
  RegionGrant,
  RegionState,
} from '@docedit/authority';
import type { AttributionMap } from '@docedit/history';
import type { Node } from 'prosemirror-model';

/** What the service tells a caller when it does not do what was asked. */
export type ServiceErrorCode =
  | 'invalid_request'
  | 'unknown_state'
  | 'not_found'
  | 'state_mismatch'
  | 'chain_broken'
  | 'payload_missing'
  | 'checkpoint_unavailable'
  | 'checkpoint_mismatch'
  | 'replay_failed'
  | 'unsupported_cdm'
  | 'unsupported_feature'
  | 'validation_failed'
  | 'migration_not_enabled'
  | 'migration_failed'
  | 'invalid_rules'
  | 'budget_exceeded'
  | 'storage_unavailable'
  | 'unauthorized';

export interface ServiceError {
  code: ServiceErrorCode;
  message: string;
  /** Further fields of the same kind as the code carries, such as the problem's path. */
  detail?: unknown;
}

export type Answer<T> = ({ ok: true } & T) | { ok: false; error: ServiceError };

export function fail(code: ServiceErrorCode, message: string, detail?: unknown): Answer<never> {
  return { ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } };
}

/** A loaded document: immutable, named by its `stateId`. */
export interface HeldState {
  stateId: string;
  doc: string;
  head: number;
  /** The first sequence number whose content can be read (the checkpoint's). */
  first: number;
  source: ContentSource;
  headDoc: Node;
  /** The `cdm` of the checkpoint the log starts from. */
  cdm: number;
  /** The `requires` of the document at each sequence number from `first` to `head`. */
  requires: Map<number, string[]>;
  /** The commits after the checkpoint, in order, and the contents of the snapshots they name. */
  log: readonly LogCommit[];
  snapshots: ReadonlyMap<string, Node>;
  /** The document at `first`: where every replay starts. */
  checkpointDoc: Node;
  /** The hash of the commit at `head` (the next commit links to it); the checkpoint's own at `first`. */
  chainHead: string | null;
  /** Who wrote the content at `first`; the history calls replay the log over it. */
  baseAttribution: AttributionMap;
}

/**
 * The permission state a caller hands to `applyCommit` (05 §10; ADR 0394). It is the state the
 * room would hold at apply time, as JSON: the service keeps none of it between calls.
 */
export interface WirePermissions {
  /** The grants revision now (04 G7). */
  revision: number;
  grants: RegionGrant[];
  regionStates?: Record<string, RegionState>;
  leases?: PermissionState['leases'];
  documentState?: DocumentState;
  workflowActive?: boolean;
  approvals?: Record<string, RegionApproval>;
}

/** The connection a commit is judged under (05 §3): who submits it and with which role. */
export interface WireAuthor {
  sub: string;
  session: string;
  role: DocRole;
  groups?: string[];
  agent?: string;
  participantRoles?: string[];
  participantActive?: boolean;
}

/** The connection a request is judged under (05 §3). */
export function connectionOf(a: WireAuthor): Connection {
  return {
    sub: a.sub,
    session: a.session,
    role: a.role,
    groups: a.groups ?? [],
    participantRoles: a.participantRoles ?? [],
    participantActive: a.participantActive ?? false,
    ...(a.agent !== undefined ? { agent: a.agent } : {}),
  };
}

export function unpackWirePerms(p: WirePermissions): PermissionState {
  return {
    revision: p.revision,
    grants: p.grants.map((g) => ({ ...g })),
    regionStates: new Map(Object.entries(p.regionStates ?? {})),
    leases: (p.leases ?? []).map((l) => ({ ...l })),
    documentState: p.documentState ?? 'active',
    workflowActive: p.workflowActive ?? false,
    ...(p.approvals ? { approvals: new Map(Object.entries(p.approvals)) } : {}),
  };
}
