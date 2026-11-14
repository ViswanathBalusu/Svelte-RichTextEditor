/**
 * The authority's in-process message shapes (packages/authority/src/room/types.ts) as DEP payloads
 * (05 §5). Each function marks where the two differ; the S6 report (docs/spikes/
 * 2026-11-06-s6-protocol.md, section 6) lists the differences for reconciliation. Moved here from
 * `backend-mock` so that the mock and the document service translate the same way.
 */
import {
  CAPABILITIES,
  fillSummary,
  regionsOf,
  SERVER_SESSION,
  type Access as RoomAccess,
  type Caps,
  type Connection,
  type PermissionState,
  type Room,
  type StoredCommit,
} from '@docedit/authority';
import { formatTimestamp } from '@docedit/model';
import type { Access, Ack, RemoteCommit, ScopeId, SyncReject } from '../generated/types.ts';

/** A document as the room holds it (a ProseMirror node; the protocol package names no ProseMirror type). */
export type RoomDocument = Room['document'];

const ordered = (caps: Caps): Access['caps'] => CAPABILITIES.filter((c) => caps.has(c));

/**
 * The room's `Access` (Sets, Maps, a grants revision, a server time) as the DEP `access` object
 * (05 §5.5). `rev` and `asOfSeq` are not in the room's shape; the caller supplies them (D12).
 * Scopes follow decision D11: `doc`, `body`, `defs`, every story and every region. `user` maps a
 * stored user to the one the wire shows (D42; the identity by default).
 */
export function toAccess(
  a: RoomAccess,
  conn: Connection,
  perms: PermissionState,
  stories: readonly string[],
  rev: number,
  asOfSeq: number,
  user: (stored: string) => string = (u) => u,
): Access {
  const scopes: Record<string, Access['caps']> = {
    doc: ordered(a.structureScopes),
    body: ordered(a.body),
    defs: ordered(a.structureScopes),
  };
  for (const s of stories) scopes[`story:${s}`] = ordered(a.structureScopes);
  for (const [id, caps] of a.regions) scopes[`region:${id}`] = ordered(caps);
  const leases: Access['leases'] = {};
  for (const l of perms.leases)
    if (l.expiresAt > a.at)
      leases[`region:${l.region}`] = {
        holder: user(l.holder),
        expiresAt: formatTimestamp(l.expiresAt),
      };
  // The authority's summary of fill rights (12 §4.1); DEP names the participant, or the user
  // when the token carries no `wfp` claim.
  const fill = fillSummary(a);
  return {
    rev,
    asOfSeq,
    docRole: conn.role,
    caps: ordered(a.docRole),
    scopes,
    leases,
    fill: fill
      ? { participant: fill.participant ?? user(conn.sub), roles: fill.roles, active: fill.active }
      : null,
    restrictions: restrictionsOf(conn),
  };
}

/** The connection's output restrictions in the wire's order, each once (PRO-015 criterion 2). */
function restrictionsOf(conn: Connection): Access['restrictions'] {
  const known: readonly Access['restrictions'][number][] = ['no-export', 'no-copy', 'no-print'];
  const given = new Set(conn.restrictions ?? []);
  return known.filter((r) => given.has(r));
}

/**
 * A stored commit as a `sync.commit` element (D10). The room stamps `system` as the session of
 * server commits, which DEP writes as a null session; the agent is the connection's delegated
 * assistant identity, never the client's claim (04 G6). `user` maps the stored user to the one the
 * wire shows (D42; the identity by default).
 */
export function toRemoteCommit(
  c: StoredCommit,
  offset: number,
  user: (stored: string) => string = (u) => u,
): RemoteCommit {
  return {
    seq: c.seq + offset,
    kind: c.kind,
    id: c.id,
    steps: c.steps,
    control: c.kind === 'control' ? { type: 'grants', rev: c.revision } : null,
    author: {
      user: user(c.user),
      session: c.session === SERVER_SESSION ? null : c.session,
      agent: c.agent ?? null,
    },
    serverTime: formatTimestamp(c.time),
    origin: c.origin,
  };
}

export function toAck(
  m: { id: string; seq: number; time: number; rebased: boolean; steps?: StoredCommit['steps'] },
  offset: number,
): Ack {
  const ack: Ack = {
    id: m.id,
    seq: m.seq + offset,
    serverTime: formatTimestamp(m.time),
    rebased: m.rebased,
  };
  if (m.steps) ack.steps = m.steps;
  return ack;
}

/**
 * The room names definitions per node (`defs:style_def/Normal`, 07 §5.1); DEP has one `defs` scope
 * (05 §5.3; G41). Other scopes pass unchanged.
 */
export function toScopes(scopes: readonly string[]): ScopeId[] {
  const out: string[] = [];
  for (const s of scopes) {
    const d = s.startsWith('defs:') ? 'defs' : s;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

export function toReject(
  m: {
    id: string;
    code: SyncReject['code'];
    action: SyncReject['action'];
    head: number;
    reason: string;
    scopes?: string[];
    retryAfterMs?: number;
    /** The rule or constraint that failed (05 §5.3 `rule`; 12 §5.3; PRO-028 criterion 4). */
    rule?: string;
  },
  offset: number,
): SyncReject {
  const r: SyncReject = {
    id: m.id,
    code: m.code,
    message: m.reason,
    action: m.action,
    head: m.head + offset,
  };
  if (m.scopes) r.scopes = toScopes(m.scopes);
  if (m.retryAfterMs !== undefined) r.retryAfterMs = m.retryAfterMs;
  if (m.rule !== undefined) r.rule = m.rule;
  return r;
}

/** The header and footer stories of a document, in order, for the `story:<id>` scopes (D11). */
export function storiesOf(doc: RoomDocument): string[] {
  const out: string[] = [];
  doc.forEach((n) => {
    if (n.type.name === 'story') out.push(String(n.attrs['id']));
  });
  return out;
}

/**
 * The region list of a document with each region's policy, as one string: a commit that changes it
 * is followed by `perm.changed` (07 §4; D12; G46).
 */
export function regionKey(doc: RoomDocument): string {
  return regionsOf(doc)
    .map((r) => `${r.id}:${r.policy}`)
    .join(',');
}
