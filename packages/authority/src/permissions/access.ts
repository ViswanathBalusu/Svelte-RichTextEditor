/**
 * Effective capabilities per scope (07 §4; PRM-004). Computed for each connection when a channel
 * opens and again whenever anything that feeds it changes.
 */
import {
  type Capability,
  type Caps,
  type Connection,
  type Lease,
  type PermissionState,
  type RegionGrant,
  type RegionPolicy,
  REGION_CAPABILITIES,
  ROLE_CAPABILITIES,
  isRegionRole,
  roleCaps,
} from './model.ts';

export interface RegionInfo {
  id: string;
  policy: RegionPolicy;
}

export interface Access {
  /** The grants revision the map was computed from (04 §5 step 7). */
  revision: number;
  /** Server time the map was computed at; grants and leases expire relative to it. */
  at: number;
  docRole: Caps;
  body: Caps;
  /** `doc`, `defs` and stories (07 §4). */
  structureScopes: Caps;
  regions: ReadonlyMap<string, Caps>;
  /** Region capabilities for a region the map has not seen (a region created by the commit). */
  newRegion: Caps;
  /**
   * Regions on which the connection holds a matching grant of any role, before the limits of 07 §4.
   * A grant names its holder as a reader of a confidential region and of the sensitive values in
   * the region (ADR 0019).
   */
  granted: ReadonlySet<string>;
  /**
   * The leases in force at `at`, with their holder and expiry (07 §10; PRM-043 criterion 4, the
   * `access.leases` member). They are shown to every connection, so a lock can name its holder.
   */
  leases: readonly Lease[];
  fill: {
    roles: readonly string[];
    active: boolean;
    allowed: boolean;
    /** The workflow participant (the `wfp` claim, 12 §7), or null. */
    participant: string | null;
  };
}

function grantMatches(
  g: RegionGrant,
  conn: Connection,
  now: number,
  workflowActive: boolean,
): boolean {
  if (g.expiresAt !== null && now >= g.expiresAt) return false;
  if (g.principal === 'everyone') return true;
  if (g.principal === `user:${conn.sub}`) return true;
  if (g.principal.startsWith('group:') && conn.groups.includes(g.principal.slice(6))) return true;
  // A role placeholder resolves to the participants bound in the active workflow (07 §1), so with no
  // active workflow it matches nobody (PRM-023 criterion 2).
  if (
    g.principal.startsWith('role:') &&
    workflowActive &&
    conn.participantRoles.includes(g.principal.slice(5))
  )
    return true;
  return false;
}

/** The capabilities of the best matching grant: the one with the most capabilities (07 §4). */
function bestGrant(
  region: string,
  policy: RegionInfo['policy'],
  conn: Connection,
  perms: PermissionState,
  now: number,
): Capability[] | null {
  let best: Capability[] | null = null;
  for (const g of perms.grants) {
    // A grant naming a role other than the four region roles is invalid (07 §2) and conveys nothing.
    if (!isRegionRole(g.role)) continue;
    if (g.region !== region || !grantMatches(g, conn, now, perms.workflowActive)) continue;
    // `everyone` on a restricted region conveys nothing (07 §17, owner decision 12 of 2026-11-15;
    // PRM-061). Grant validation refuses it; a stored one fails closed here.
    if (g.principal === 'everyone' && policy === 'restricted') continue;
    const c = ROLE_CAPABILITIES[g.role].filter((x) => REGION_CAPABILITIES.includes(x));
    if (!best || c.length > best.length) best = c;
  }
  return best;
}

function regionCaps(
  region: RegionInfo,
  grant: Capability[] | null,
  conn: Connection,
  perms: PermissionState,
  now: number,
): Set<Capability> {
  const role = ROLE_CAPABILITIES[conn.role];
  let out: Set<Capability>;
  if (conn.role === 'owner') out = new Set(REGION_CAPABILITIES);
  else if (region.policy === 'inherit') {
    out = new Set([...role, ...(grant ?? [])].filter((c) => REGION_CAPABILITIES.includes(c)));
  } else if (region.policy === 'restricted') {
    out = grant ? new Set(grant) : new Set(role.filter((c) => c === 'view' || c === 'comment'));
  } else {
    // Confidential (ADR 0019): only a grant, of any role, conveys anything, `view` included. With
    // none the reader gets nothing of the region but its placeholder. Owners hold `manage`, the
    // only document role that reads every region.
    out = grant ? new Set(grant) : new Set();
  }
  // Version 1 restricts changing; reading is restricted only for confidential regions (ADR 0019).
  if (region.policy !== 'confidential') out.add('view');
  // Limits, in order (07 §4). They only ever remove capabilities.
  const state = perms.regionStates.get(region.id) ?? 'draft';
  if (state === 'approved') limit(out, ['view', 'comment']);
  const lease = perms.leases.find((l) => l.region === region.id && l.expiresAt > now);
  if (lease && lease.holder !== conn.sub) limit(out, ['view', 'comment']);
  return out;
}

/** What an agent connection may hold in a scope, at most (ADR 0234 A3). */
const AGENT_CAPS: Capability[] = ['view', 'comment', 'suggest'];

function limit(set: Set<Capability>, allowed: Capability[]): void {
  for (const c of [...set]) if (!allowed.includes(c)) set.delete(c);
}

export function computeAccess(
  conn: Connection,
  regions: readonly RegionInfo[],
  perms: PermissionState,
  now: number,
): Access {
  const docRole = roleCaps(conn.role);
  const body = new Set(docRole);
  const structureScopes = new Set<Capability>(['view']);
  if (docRole.has('structure')) structureScopes.add('edit');

  const regionMap = new Map<string, Caps>();
  const granted = new Set<string>();
  for (const r of regions) {
    const grant = bestGrant(r.id, r.policy, conn, perms, now);
    if (grant) granted.add(r.id);
    regionMap.set(r.id, regionCaps(r, grant, conn, perms, now));
  }
  const fresh: RegionInfo = { id: '\u0000new', policy: 'inherit' };
  const newRegion = regionCaps(
    fresh,
    bestGrant(fresh.id, fresh.policy, conn, perms, now),
    conn,
    perms,
    now,
  );

  // Document state limit (07 §4 limit 1): view only, comment when locked, fill where a workflow allows.
  const fillAllowed =
    docRole.has('fill') && (perms.documentState === 'active' || perms.workflowActive);
  if (perms.documentState !== 'active') {
    const keep: Capability[] = perms.documentState === 'locked' ? ['view', 'comment'] : ['view'];
    for (const s of [body, structureScopes, newRegion]) limit(s, keep);
    for (const s of regionMap.values()) limit(s as Set<Capability>, keep);
  }
  // An agent connection holds at most `suggest` in every scope (07 §4; ADR 0234 A3, UX-044): the
  // intersection of what the user holds and `{view, comment, suggest}`. It never holds `edit`, `fill`,
  // `structure` or `manage`, so P4 applies to everything it submits, an editor's agent included.
  const agent = conn.agent !== undefined;
  const capped = (caps: Caps): Caps => {
    if (!agent) return caps;
    const out = new Set<Capability>(caps);
    limit(out, AGENT_CAPS);
    return out;
  };
  return {
    revision: perms.revision,
    at: now,
    docRole: capped(docRole),
    body: capped(body),
    structureScopes: capped(structureScopes),
    regions: agent ? new Map([...regionMap].map(([id, caps]) => [id, capped(caps)])) : regionMap,
    newRegion: capped(newRegion),
    granted,
    leases: perms.leases.filter((l) => l.expiresAt > now),
    fill: {
      roles: conn.participantRoles,
      active: conn.participantActive,
      allowed: fillAllowed && !agent,
      participant: conn.participant ?? null,
    },
  };
}

/** P6: a connection whose capabilities are only `view` or `comment` anywhere cannot submit (07 §5.2). */
export function canSubmitAnything(a: Access): boolean {
  const any = (c: Caps) => c.has('edit') || c.has('suggest');
  if (any(a.body) || any(a.structureScopes) || any(a.newRegion)) return true;
  for (const c of a.regions.values()) if (any(c)) return true;
  return a.fill.allowed;
}

/**
 * Whether a capability is held in at least one scope of the document: "`edit`, `suggest` or `fill`
 * somewhere in the document" of 07 §12 (PRM-056). `fill` counts where the document state lets the
 * connection fill; `structure` and `manage` are document-level capabilities.
 */
export function holdsSomewhere(a: Access, cap: Capability): boolean {
  if (cap === 'fill') return a.fill.allowed;
  if (cap === 'structure' || cap === 'manage') return a.docRole.has(cap);
  if (a.body.has(cap) || a.structureScopes.has(cap)) return true;
  for (const c of a.regions.values()) if (c.has(cap)) return true;
  return false;
}

/**
 * The `fill` member of DEP's `access` object (12 §4.1; 05 §5.5): the participant, the roles it may
 * fill and whether it is active, or null for a connection with no fill rights. It does not list
 * fields: the client derives them from `assignee` and the rules.
 */
export function fillSummary(
  a: Access,
): { participant: string | null; roles: string[]; active: boolean } | null {
  if (!a.fill.allowed || a.fill.roles.length === 0) return null;
  return { participant: a.fill.participant, roles: [...a.fill.roles], active: a.fill.active };
}

/**
 * The earliest time after `now` at which a grant or a lease expires, or null when none will
 * (07 §4, last paragraph; PRM-007). The room recomputes access then, so that an expiry takes
 * effect without a triggering event.
 */
export function nextExpiry(perms: PermissionState, now: number): number | null {
  let next: number | null = null;
  const consider = (t: number | null) => {
    if (t !== null && t > now && (next === null || t < next)) next = t;
  };
  for (const g of perms.grants) consider(g.expiresAt);
  for (const l of perms.leases) consider(l.expiresAt);
  return next;
}

const sameCaps = (a: Caps, b: Caps): boolean => a.size === b.size && [...a].every((c) => b.has(c));

/** Whether two access maps convey the same capabilities (their computation time aside). */
export function sameAccess(a: Access, b: Access): boolean {
  if (a.revision !== b.revision) return false;
  if (!sameCaps(a.docRole, b.docRole) || !sameCaps(a.body, b.body)) return false;
  if (!sameCaps(a.structureScopes, b.structureScopes) || !sameCaps(a.newRegion, b.newRegion))
    return false;
  if (a.regions.size !== b.regions.size || a.granted.size !== b.granted.size) return false;
  for (const [id, c] of a.regions) {
    const d = b.regions.get(id);
    if (!d || !sameCaps(c, d)) return false;
  }
  for (const id of a.granted) if (!b.granted.has(id)) return false;
  if (a.leases.length !== b.leases.length) return false;
  for (const [i, l] of a.leases.entries()) {
    const m = b.leases[i]!;
    if (l.region !== m.region || l.holder !== m.holder || l.expiresAt !== m.expiresAt) return false;
  }
  return (
    a.fill.allowed === b.fill.allowed &&
    a.fill.active === b.fill.active &&
    a.fill.participant === b.fill.participant &&
    a.fill.roles.length === b.fill.roles.length &&
    a.fill.roles.every((r, i) => b.fill.roles[i] === r)
  );
}
