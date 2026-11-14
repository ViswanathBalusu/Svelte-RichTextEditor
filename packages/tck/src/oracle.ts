/**
 * The permission oracle of the property tests (PRO-113 criterion 4; PRM-009): the outcome check of
 * the project's authority, applied to the documents before and after a commit the server accepted.
 * The server under test is a black box; only its verdict and the content it serves are compared
 * with what the reference semantics allow (05 §9: a native backend passes the same fixtures).
 */
import {
  EMPTY_PERMISSIONS,
  computeAccess,
  diffScopes,
  outcomeCheck,
  regionInfos,
  type Connection,
  type DocRole,
  type PermissionState,
  type RegionGrant,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';

type Schema = ReturnType<typeof cdmSchema>;
type Node = ReturnType<Schema['nodeFromJSON']>;

let schema: Schema | null = null;

/** A ProseMirror node of the CDM schema from CDM JSON. */
export function toNode(doc: unknown): Node {
  schema ??= cdmSchema();
  return schema.nodeFromJSON(doc);
}

export interface OracleUser {
  sub: string;
  role: DocRole;
  groups?: readonly string[];
}

export interface OracleGrant {
  region: string;
  principal: string;
  role: RegionGrant['role'];
}

/** The permission state the kit set up, as the authority models it (07 §3). */
export function permissionState(
  grants: readonly OracleGrant[],
  documentState: PermissionState['documentState'] = 'active',
): PermissionState {
  return {
    ...EMPTY_PERMISSIONS,
    revision: 1,
    grants: grants.map((g) => ({
      region: g.region,
      principal: g.principal as RegionGrant['principal'],
      role: g.role,
      expiresAt: null,
    })),
    documentState,
  };
}

export interface OracleVerdict {
  ok: boolean;
  /** Scopes the commit changed. */
  changed: string[];
  reason: string;
}

/** Whether the reference outcome check accepts the change from `before` to `after` for `user`. */
export function judge(
  before: unknown,
  after: unknown,
  user: OracleUser,
  perms: PermissionState,
): OracleVerdict {
  const b = toNode(before);
  const a = toNode(after);
  const conn: Connection = {
    sub: user.sub,
    session: 'tck-oracle',
    role: user.role,
    groups: [...(user.groups ?? [])],
    participantRoles: [],
    participantActive: false,
  };
  const access = computeAccess(conn, regionInfos(b), perms, Date.now());
  const verdict = outcomeCheck({
    before: b,
    after: a,
    user: user.sub,
    access,
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
  });
  const changed = diffScopes(b, a).changed;
  return verdict.ok
    ? { ok: true, changed, reason: 'accepted' }
    : { ok: false, changed, reason: `${verdict.code}: ${verdict.reason}` };
}
