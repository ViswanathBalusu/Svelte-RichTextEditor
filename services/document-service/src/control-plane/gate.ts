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
  roleCaps,
} from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import type { DocRef, DocumentRecord, LogStore } from '../storage/types.ts';
import { stateAllowed } from '../data-plane/gate.ts';
import { regionsOfJson } from './content.ts';
import type { HandlerDeps } from './kit.ts';
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
  /**
   * A connection to compute the gate for instead of the caller's own: the user a service
   * credential acts for (ADR 0379). Absent: the caller's.
   */
  as?: Connection;
  ref: DocRef;
  record: DocumentRecord;
  head: number;
  regions: readonly RegionInfo[];
  perms: PermissionState;
  logs: LogStore;
  now: number;
}): Promise<number> {
  const conn = opts.as ?? connectionOn(opts.caller, opts.ref.doc);
  if (!conn) return 0;
  const edits = editsSomewhere(conn, opts.regions, opts.perms, opts.now);
  // The rule is the authority's; only the reading of commit times from storage is done here.
  return minVisibleSeqAsync({
    setting: settingOf(opts.record),
    editsSomewhere: edits,
    accessSince: opts.as ? undefined : opts.caller.identity?.accessSince,
    head: opts.head,
    timeOf: async (seq) =>
      (opts.logs.readMeta
        ? await opts.logs.readMeta(opts.ref, seq, seq)
        : await opts.logs.read(opts.ref, seq, seq))[0]?.time,
  });
}

/** Refuses a `seq` below the caller's gate (07 §8; PRM-041): the same answer on every route. */
export function refuseBelowGate(
  seq: number,
  min: number,
  head: number,
  what = 'seq',
  named?: (seq: number) => boolean,
): void {
  // A single state at the head is always visible, and so is a named version (ADR 0034).
  if (stateAllowed(min, seq, head, named)) return;
  throw new ApiError(
    'forbidden',
    `the ${what} is below the history visibility of the caller (07 §8)`,
  );
}

/**
 * The connection of the user a service credential names in `DEP-Actor`, for the history gate only
 * (PRM-042 criterion 4; ADR 0379, proposed). The user's document role and groups live in the host's
 * tokens, which a service credential does not carry, so the connection holds the lowest role and no
 * group: the gate fails closed, and only a grant stored for the user (by surrogate) opens more history.
 */
export function actingConnection(surrogate: string): Connection {
  return {
    sub: surrogate,
    session: 'service',
    role: 'viewer',
    groups: [],
    participantRoles: [],
    participantActive: false,
  };
}

/**
 * Refuses a `seq` below the gate of the caller, or of `opts.as` (07 §8; PRM-041, PRM-042). The head
 * and a named version of the document are always readable (ADR 0034). A role with `edit` sees full
 * history under the default setting without reading regions. A service credential without `as`
 * reads full history.
 */
export async function refuseSeqBelowGate(
  d: HandlerDeps,
  caller: Caller,
  ref: DocRef,
  record: DocumentRecord,
  head: number,
  seq: number,
  opts: { as?: Connection; what?: string } = {},
): Promise<void> {
  if (seq >= head) return;
  if (!opts.as) {
    if (caller.kind === 'service') return;
    const role = caller.identity!.docs[record.id];
    if (record.historyVisibility === 'editors' && role && roleCaps(role).has('edit')) return;
  }
  const full = await d.content.rebuild(ref, (await d.logs.head(ref)).incarnation, head);
  const min = await minVisibleSeqOf({
    caller,
    ...(opts.as ? { as: opts.as } : {}),
    ref,
    record,
    head,
    regions: regionInfosOfJson(full.doc),
    perms: await d.grants.current(ref),
    logs: d.logs,
    now: d.now(),
  });
  if (stateAllowed(min, seq, head)) return;
  const named = new Set(
    d.versions ? (await d.versions.list(ref, { kind: 'named' })).map((v) => v.seq) : [],
  );
  refuseBelowGate(seq, min, head, opts.what, (s) => named.has(s));
}
