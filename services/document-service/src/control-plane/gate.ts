/**
 * What a caller may do and see on one document, from the permission data in storage at the time
 * of the request: the access of 07 §4 with the document's regions and grants (rows of 07 §12 that
 * hold "somewhere in the document" need both), and the history visibility gate of 07 §8
 * (`minVisibleSeq`; PRM-041; HIS-024; ADR 0034), which every route that takes a `seq` applies.
 *
 * A service credential acts for the tenant: it passes every gate and reads full history.
 */
import {
  type Access,
  type Connection,
  DEFAULT_HISTORY_VISIBILITY,
  authorise,
  HISTORY_VISIBILITIES,
  type HistoryVisibility,
  type PermissionState,
  type RegionInfo,
  computeAccess,
  editsSomewhere,
  minVisibleSeqAsync,
  regionPolicyOf,
} from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import type { DocRef, DocumentRecord, LogStore } from '../storage/types.ts';
import { stateAllowed } from '../data-plane/gate.ts';
import { regionsOfJson } from './content.ts';
import type { Caller } from './pipeline.ts';
import { ApiError } from './problems.ts';

/** The regions of a document's body as the authority reads them. */
export function regionInfosOfJson(doc: JsonNode): RegionInfo[] {
  return regionsOfJson(doc).map((r) => ({ id: r.id, policy: regionPolicyOf(r.policy) }));
}

/** The connection of a user caller on `doc`, or null for a service credential. */
export function connectionOn(caller: Caller, doc: string): Connection | null {
  if (caller.kind === 'service') return null;
  const role = caller.identity!.docs[doc];
  if (role === undefined)
    throw new ApiError('forbidden', `the token does not cover document ${doc}`);
  return { ...caller.identity!.connection, role };
}

/** The caller's access on a document with its regions and the grants in storage (07 §4). */
export function accessOf(
  conn: Connection,
  regions: readonly RegionInfo[],
  perms: PermissionState,
  now: number,
): Access {
  return computeAccess(conn, regions, perms, now);
}

/**
 * Refuses unless the caller meets the row `rowId` of the authorisation matrix (07 §12) somewhere in
 * the document, through its role or a grant (rows 6 and 8). The requirement is the matrix's, read
 * by `authorise`; no caller passes a copy of it (PRM-056 criterion 3). A service credential passes.
 */
export function requireRow(
  caller: Caller,
  rowId: string,
  doc: string,
  regions: readonly RegionInfo[],
  perms: PermissionState,
  now: number,
): void {
  const conn = connectionOn(caller, doc);
  if (!conn) return;
  const verdict = authorise(rowId, {
    credential: 'user',
    access: accessOf(conn, regions, perms, now),
  });
  if (!verdict.ok) throw new ApiError('forbidden', `${verdict.reason} (07 §12)`);
}

/**
 * Whether the connection holds `edit` somewhere in the document (07 §12). The rule is the
 * authority's `editsSomewhere`, the same one that decides who sees full history (08 §9); routes
 * that need the answer for another purpose ask here and do not call the authority themselves.
 */
export function holdsEditSomewhere(
  conn: Connection,
  regions: readonly RegionInfo[],
  perms: PermissionState,
  now: number,
): boolean {
  return editsSomewhere(conn, regions, perms, now);
}

function settingOf(record: DocumentRecord): HistoryVisibility {
  const s = record.historyVisibility as HistoryVisibility;
  return HISTORY_VISIBILITIES.includes(s) ? s : DEFAULT_HISTORY_VISIBILITY;
}

/**
 * `minVisibleSeq` of the caller (07 §8): the lowest `seq` whose content they may read. For
 * `since_access` the commit times come from the log, read only where the search looks.
 */
export async function minVisibleSeqOf(opts: {
  caller: Caller;
  ref: DocRef;
  record: DocumentRecord;
  head: number;
  regions: readonly RegionInfo[];
  perms: PermissionState;
  logs: LogStore;
  now: number;
}): Promise<number> {
  const conn = connectionOn(opts.caller, opts.ref.doc);
  if (!conn) return 0;
  const edits = editsSomewhere(conn, opts.regions, opts.perms, opts.now);
  // The rule is the authority's; only the reading of commit times from storage is done here.
  return minVisibleSeqAsync({
    setting: settingOf(opts.record),
    editsSomewhere: edits,
    accessSince: opts.caller.identity?.accessSince,
    head: opts.head,
    timeOf: async (seq) => (await opts.logs.read(opts.ref, seq, seq))[0]?.time,
  });
}

/** Refuses a `seq` below the caller's gate (07 §8; PRM-041): the same answer on every route. */
export function refuseBelowGate(seq: number, min: number, head: number, what = 'seq'): void {
  // A single state at the head is always visible (ADR 0034).
  if (stateAllowed(min, seq, head)) return;
  throw new ApiError(
    'forbidden',
    `the ${what} is below the history visibility of the caller (07 §8)`,
  );
}
