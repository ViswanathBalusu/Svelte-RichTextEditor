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
  minVisibleSeq,
  regionPolicyOf,
} from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import type { DocRef, DocumentRecord, LogStore } from '../storage/types.ts';
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
  const setting = settingOf(opts.record);
  const edits = editsSomewhere(conn, opts.regions, opts.perms, opts.now);
  if (setting !== 'since_access')
    return minVisibleSeq({
      setting,
      editsSomewhere: edits,
      head: opts.head,
      timeOf: () => undefined,
    });
  const since = opts.caller.identity?.accessSince;
  if (since === undefined) return opts.head;
  // The last commit stored at or before `since`; commit times are taken as non-decreasing.
  let lo = 1;
  let hi = opts.head;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [c] = await opts.logs.read(opts.ref, mid, mid);
    if (c && c.time <= since) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Refuses a `seq` below the caller's gate (07 §8; PRM-041): the same answer on every route. */
export function refuseBelowGate(seq: number, min: number, head: number, what = 'seq'): void {
  // A single state at the head is always visible (ADR 0034).
  if (seq >= min || seq === head) return;
  throw new ApiError(
    'forbidden',
    `the ${what} is below the history visibility of the caller (07 §8)`,
  );
}
