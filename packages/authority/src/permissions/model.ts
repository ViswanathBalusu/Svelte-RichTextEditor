/**
 * Capabilities, roles, scopes and principals, defined once (07 §1, §2; 12 §4.1; PRM-001).
 */
import { NODE_ID_PATTERN } from '@docedit/model';
import { DEFINITION_ID_PATTERN } from '@docedit/model/definition';

export const CAPABILITIES = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type DocRole = 'viewer' | 'commenter' | 'suggester' | 'filler' | 'editor' | 'owner';
/** Region grants use these roles only (07 §2). */
export type RegionRole = 'viewer' | 'commenter' | 'suggester' | 'editor';

export const DOC_ROLES: readonly DocRole[] = [
  'viewer',
  'commenter',
  'suggester',
  'filler',
  'editor',
  'owner',
];
/** "Region grants use the roles viewer, commenter, suggester and editor" (07 §2). */
export const REGION_ROLES: readonly RegionRole[] = ['viewer', 'commenter', 'suggester', 'editor'];

export function isRegionRole(role: unknown): role is RegionRole {
  return typeof role === 'string' && (REGION_ROLES as readonly string[]).includes(role);
}

/**
 * 07 §2. `structure` for an editor is document level only: a region grant never conveys the
 * capability. It may list two of its operations (`structure` member, ADR 0424), which is not the
 * capability and leaves this table unchanged.
 */
export const ROLE_CAPABILITIES: Readonly<Record<DocRole, readonly Capability[]>> = {
  viewer: ['view'],
  commenter: ['view', 'comment'],
  suggester: ['view', 'comment', 'suggest'],
  filler: ['view', 'fill'],
  editor: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure'],
  owner: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'],
};

/** The four capabilities a region scope can carry (07 §4). */
export const REGION_CAPABILITIES: readonly Capability[] = ['view', 'comment', 'suggest', 'edit'];

export type Caps = ReadonlySet<Capability>;

export function caps(...list: Capability[]): Set<Capability> {
  return new Set(list);
}

export function roleCaps(role: DocRole): Set<Capability> {
  return new Set(ROLE_CAPABILITIES[role]);
}

/**
 * Region policies (07 §1). `confidential` is ADR 0019's third value (proposed): only principals
 * with a grant on the region, and users with `manage`, may read it. The CDM gains the value in
 * CDM-053; until then the invariants refuse it in stored documents.
 */
export const REGION_POLICIES = ['inherit', 'restricted', 'confidential'] as const;
export type RegionPolicy = (typeof REGION_POLICIES)[number];

/**
 * The policy a region node's `policy` attribute stands for. A missing value is the schema's
 * default, `inherit`. Any value the authority does not know is read as `confidential`, the
 * strictest policy, so that an unknown value can never widen what anyone may read or change.
 */
export function regionPolicyOf(value: unknown): RegionPolicy {
  if (value === undefined || value === null || value === 'inherit') return 'inherit';
  if (value === 'restricted') return 'restricted';
  return 'confidential';
}

/**
 * The operations that need `structure` and those that need `manage` (07 §2), each listed exactly
 * once, so that the rules that enforce them cite one list (PRM-001). `where` says who enforces an
 * operation: the outcome check on commits (07 §5) or the control plane on requests (07 §12).
 *
 * Creating a region with a policy other than `inherit` is two operations: `region.create` and
 * `region.policy`. Inserting a field with `sensitive` set is `field.sensitive` (ADR 0033).
 */
export interface Operation {
  readonly id: string;
  readonly needs: 'structure' | 'manage';
  readonly where: 'commit' | 'control';
  readonly spec: string;
  readonly text: string;
  /**
   * Set on the operations whose effect stays inside one region or only adds, so that a region grant
   * may carry them in its `structure` list (ADR 0424; owner decision 279; PRM-068). Only
   * `structure` operations can carry it; `manage` never becomes grantable per region.
   */
  readonly perRegion?: true;
}

export const OPERATIONS = [
  {
    id: 'region.create',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2',
    text: 'Create a region, including by wrapping blocks of the body.',
  },
  {
    id: 'region.delete',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2',
    text: 'Delete a region as a whole node.',
  },
  {
    id: 'region.split',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2; ADR 0033',
    text: 'Split a region: one part keeps the identifier and the other is created.',
  },
  {
    id: 'region.merge',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2; ADR 0033',
    text: 'Merge regions: one is deleted and its blocks are moved into the other.',
  },
  {
    id: 'region.move',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2',
    text: 'Move a region among the blocks of the body.',
  },
  {
    id: 'region.retitle',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2; ADR 0424',
    text: "Change a region's title.",
    perRegion: true,
  },
  {
    id: 'section_break.change',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, P2',
    text: 'Insert, remove or move a section break, or change its attributes.',
  },
  {
    id: 'doc.change',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, §4',
    text: 'Change the top of the tree: which stories exist, the attributes of the body, the definitions node and their order.',
  },
  {
    id: 'defs.add',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, §5.3, §17; ADR 0424',
    text: 'Add a new style definition that no earlier commit used. It never changes or removes an existing definition.',
    perRegion: true,
  },
  {
    id: 'defs.change',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, §4, §5.3',
    text: 'Change a definition: settings, a style, a numbering definition, a page setup, a role or a rule.',
  },
  {
    id: 'story.change',
    needs: 'structure',
    where: 'commit',
    spec: '07 §2, §4',
    text: 'Change a header or footer story.',
  },
  {
    id: 'grants.change',
    needs: 'manage',
    where: 'control',
    spec: '07 §2, §12',
    text: 'Create, change or remove region grants.',
  },
  {
    id: 'region_state.change',
    needs: 'manage',
    where: 'control',
    spec: '07 §2, §11, §12',
    text: "Change a region's state.",
  },
  {
    id: 'region.policy',
    needs: 'manage',
    where: 'commit',
    spec: '07 §2, P2, §16; ADR 0019',
    text: "Change a region's policy, including to and from confidential, or create a region whose policy is not inherit.",
  },
  {
    id: 'lease.break',
    needs: 'manage',
    where: 'control',
    spec: '07 §2, §10, §12',
    text: "Break another user's lease.",
  },
  {
    id: 'workflow.action',
    needs: 'manage',
    where: 'control',
    spec: '07 §2, §12; 12 §6.2',
    text: 'Send, correct, resume, void or remind a workflow.',
  },
  {
    id: 'workflow.evidence',
    needs: 'manage',
    where: 'control',
    spec: '07 §12; 12 §8.2',
    text: 'Fetch the evidence bundle of a workflow; every retrieval is audited.',
  },
  {
    id: 'document.restore',
    needs: 'manage',
    where: 'control',
    spec: '07 §2, §12, §13',
    text: 'Restore the whole document.',
  },
  {
    id: 'document.delete',
    needs: 'manage',
    where: 'control',
    spec: '07 §2, §12',
    text: 'Delete the document.',
  },
  {
    id: 'settings.track_changes_on',
    needs: 'manage',
    where: 'commit',
    spec: '07 §5.2; owner decision 118',
    text: 'Switch `settings.trackChanges` from `off` to `everyone`.',
  },
  {
    id: 'settings.track_changes_off',
    needs: 'manage',
    where: 'commit',
    spec: '07 §5.2',
    text: 'Switch `settings.trackChanges` from `everyone` to `off`.',
  },
  {
    id: 'field.sensitive',
    needs: 'manage',
    where: 'commit',
    spec: 'ADR 0019 (change 5)',
    text: "Set or clear a field's `sensitive` attribute, including by inserting a field with it set.",
  },
] as const satisfies readonly Operation[];

export type OperationId = (typeof OPERATIONS)[number]['id'];

export const STRUCTURE_OPERATIONS: readonly OperationId[] = OPERATIONS.filter(
  (o) => o.needs === 'structure',
).map((o) => o.id);
/**
 * The operations a region grant may list in `structure` (ADR 0424; decision 279): `region.retitle`
 * and `defs.add`.
 */
export const REGION_STRUCTURE_OPERATIONS: readonly OperationId[] = OPERATIONS.filter(
  (o) => 'perRegion' in o,
).map((o) => o.id);
export const MANAGE_OPERATIONS: readonly OperationId[] = OPERATIONS.filter(
  (o) => o.needs === 'manage',
).map((o) => o.id);

/** The operation with this identifier. */
export function operationById(id: OperationId): Operation {
  return OPERATIONS.find((o) => o.id === id)!;
}

/** "`region.policy` needs `manage` (07 §2, P2, §16; ADR 0019)", for rejection reasons. */
export function operationNeeds(id: OperationId): string {
  const op = operationById(id);
  return `\`${op.id}\` needs \`${op.needs}\` (${op.spec})`;
}

/**
 * Scopes (07 §1; 05 §5.3; 12 §4.1): `doc`, `body`, `defs`, `story:<id>`, `region:<id>` and
 * `field:<id>`. Definitions are also one scope each (07 §5.1: "defs (per definition node)"), written
 * `defs:<type>/<id>`, or `defs:settings` for the one node without an identifier; `defs` names them
 * all. Story, region and field identifiers are node identifiers (03 §9); definition identifiers
 * follow the definition grammar (CDM-002).
 */
export type Scope =
  | { kind: 'doc' }
  | { kind: 'body' }
  | { kind: 'defs'; node: string | null; id: string | null }
  | { kind: 'story'; id: string }
  | { kind: 'region'; id: string }
  | { kind: 'field'; id: string };

export function formatScope(s: Scope): string {
  switch (s.kind) {
    case 'doc':
    case 'body':
      return s.kind;
    case 'defs':
      if (s.node === null) return 'defs';
      return s.id === null ? `defs:${s.node}` : `defs:${s.node}/${s.id}`;
    case 'story':
    case 'region':
    case 'field':
      return `${s.kind}:${s.id}`;
  }
}

const inner = (pattern: string) => pattern.slice(1, -1); // strip ^ and $
const SCOPE_RE = new RegExp(
  `^(?:(doc|body|defs)|defs:([a-z_]+)(?:/(${inner(DEFINITION_ID_PATTERN)}))?|(story|region|field):(${inner(NODE_ID_PATTERN)}))$`,
);

/** Parses a scope string; returns null for anything else (PRM-001). */
export function parseScope(text: string): Scope | null {
  const m = SCOPE_RE.exec(text);
  if (!m) return null;
  if (m[1] === 'defs') return { kind: 'defs', node: null, id: null };
  if (m[1]) return { kind: m[1] as 'doc' | 'body' };
  if (m[2]) return { kind: 'defs', node: m[2], id: m[3] ?? null };
  return { kind: m[4] as 'story' | 'region' | 'field', id: m[5]! };
}

/**
 * Principals (07 §1): `user:<sub>`, `group:<id>`, `everyone`, `role:<id>`. The `sub` and group
 * identifiers are opaque values of the token (05 §3.1); they are accepted as 1 to 255 characters
 * without control characters or whitespace. A `role:` names a role placeholder, whose identifier
 * follows the definition grammar (12 §3.1).
 */
export type Principal = string;

export type ParsedPrincipal =
  | { kind: 'user'; sub: string }
  | { kind: 'group'; id: string }
  | { kind: 'everyone' }
  | { kind: 'role'; id: string };

// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const OPAQUE_RE = /^[^\s\u0000-\u001f\u007f-\u009f]{1,255}$/;
const DEFINITION_ID_RE = new RegExp(DEFINITION_ID_PATTERN);

/** Parses a principal; returns null for anything else (PRM-001). */
export function parsePrincipal(text: string): ParsedPrincipal | null {
  if (text === 'everyone') return { kind: 'everyone' };
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const value = text.slice(colon + 1);
  if (kind === 'user' && OPAQUE_RE.test(value)) return { kind: 'user', sub: value };
  if (kind === 'group' && OPAQUE_RE.test(value)) return { kind: 'group', id: value };
  if (kind === 'role' && DEFINITION_ID_RE.test(value)) return { kind: 'role', id: value };
  return null;
}

export function formatPrincipal(p: ParsedPrincipal): Principal {
  switch (p.kind) {
    case 'everyone':
      return 'everyone';
    case 'user':
      return `user:${p.sub}`;
    case 'group':
    case 'role':
      return `${p.kind}:${p.id}`;
  }
}

export interface RegionGrant {
  region: string;
  principal: Principal;
  role: RegionRole;
  /** Server time (Unix ms) after which the grant no longer matches, or null. */
  expiresAt: number | null;
  /**
   * The parts of `structure` this grant conveys on top of its role (ADR 0424; PRM-068): only with
   * the role `editor`, and only operations that carry `perRegion`. Absent means none.
   */
  structure?: readonly OperationId[];
}

const NODE_ID_RE = new RegExp(NODE_ID_PATTERN);

/**
 * The problems of a region grant, or an empty list (07 §1, §2; PRM-001). A grant names a region by
 * its node identifier, a principal of one of the four forms, one of the four region roles (so a
 * region grant never conveys `fill`, `structure` or `manage`), an expiry in Unix milliseconds or
 * null, and optionally a `structure` list of the operations that may be granted per region (ADR
 * 0424; `validateGrantStructure`). On a `restricted` region (when `policy` says so) the principal `everyone` is refused:
 * it would make the region behave like an `inherit` one for that role (07 §17; owner decision 12 of
 * 2026-11-15, PRM-061).
 */
export function validateRegionGrant(grant: unknown, policy?: RegionPolicy): string[] {
  if (typeof grant !== 'object' || grant === null) return ['a grant is an object'];
  const g = grant as Record<string, unknown>;
  const out: string[] = [];
  if (typeof g['region'] !== 'string' || !NODE_ID_RE.test(g['region']))
    out.push('region must be a node identifier');
  if (typeof g['principal'] !== 'string' || !parsePrincipal(g['principal']))
    out.push('principal must be user:<sub>, group:<id>, everyone or role:<id>');
  if (g['principal'] === 'everyone' && policy === 'restricted')
    out.push(
      'everyone cannot be granted a role on a restricted region; name users or groups instead',
    );
  if (!isRegionRole(g['role']))
    out.push(
      `role must be one of ${REGION_ROLES.join(', ')}; region grants never convey fill, structure or manage`,
    );
  if (g['expiresAt'] !== null && !Number.isSafeInteger(g['expiresAt']))
    out.push('expiresAt must be Unix milliseconds or null');
  if ('structure' in g) out.push(...validateGrantStructure(g['structure'], g['role']));
  for (const key of Object.keys(g))
    if (!['region', 'principal', 'role', 'expiresAt', 'structure'].includes(key))
      out.push(`unknown member ${key}`);
  return out;
}

/**
 * The problems of the `structure` list of a region grant (ADR 0424; PRM-068). The list is closed:
 * only operations marked `perRegion` in `OPERATIONS`, each at most once, and only with the role
 * `editor`, because the operations are of no use without `edit` in the region. The reason names
 * the entry that is wrong.
 */
export function validateGrantStructure(list: unknown, role: unknown): string[] {
  if (!Array.isArray(list)) return ['structure must be a list of operation identifiers'];
  const out: string[] = [];
  if (role !== 'editor')
    out.push('structure can be listed only with the role editor; the operations need edit');
  const seen = new Set<unknown>();
  for (const [i, op] of list.entries()) {
    if (typeof op !== 'string' || !OPERATIONS.some((o) => o.id === op))
      out.push(`structure[${i}] is not an operation identifier`);
    else if (!(REGION_STRUCTURE_OPERATIONS as readonly string[]).includes(op))
      out.push(
        `structure[${i}] \`${op}\` cannot be granted per region; it stays with ${operationNeeds(op as OperationId)}`,
      );
    else if (seen.has(op)) out.push(`structure[${i}] \`${op}\` is listed twice`);
    seen.add(op);
  }
  return out;
}

export type DocumentState = 'active' | 'locked' | 'archived';
export type RegionState = 'draft' | 'in_review' | 'approved';

export interface Lease {
  region: string;
  holder: string; // user sub
  expiresAt: number;
  /** The lease's identifier (05 §6.2 `Lease.id`), when the store keeps it. */
  id?: string;
  /** When the lease was acquired, for the eight-hour maximum of 07 §10 (PRM-044). */
  acquiredAt?: number;
}

/** What the room knows about a connection (05 §3 token claims). */
export interface Connection {
  sub: string;
  session: string;
  /** A delegated assistant identity acting for `sub`, from the authenticated identity (04 G6). */
  agent?: string;
  role: DocRole;
  groups: readonly string[];
  /** Role placeholders the user's participant holds in the active workflow (12 §4.1). */
  participantRoles: readonly string[];
  /** Whether that participant is active in the workflow (P7). */
  participantActive: boolean;
  /** The workflow participant identifier from the token's `wfp` claim (12 §7), when there is one. */
  participant?: string;
  /**
   * The token's raw `sub` and `wfp` claim, when it carries `wfp` (12 §7; FRW-038). The room binds
   * them to a participant of the workflow it holds: `participant`, `participantRoles` and
   * `participantActive` of a connection with a claim come from that binding and from nothing
   * else, so a token that binds to no one has no fill capability, whatever else it claims.
   */
  participantClaim?: { readonly sub: string; readonly wfp: string };
  /**
   * Output restrictions of the token's `restrict` claim (PRO-015). They reach `access.restrictions`
   * on the wire and a change of them is a change of access (`perm.changed`). Absent means none.
   */
  restrictions?: readonly string[];
}

/** Whether two sets of output restrictions hold the same values (order and repeats ignored). */
export function sameRestrictions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const x = new Set(a ?? []);
  const y = new Set(b ?? []);
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

/** What an approval is bound to (07 §11; PRM-046). */
export interface RegionApproval {
  /** The sequence number the region's content was approved at. */
  seq: number;
  /** SHA-256 (hex) of the region's canonical content at `seq`, field values excluded (SR-M25). */
  hash: string;
}

/** Permission state of a document as the room holds it (07 §3). */
export interface PermissionState {
  /** Grants revision: every change increments it; log writes are conditional on it (G7). */
  revision: number;
  grants: readonly RegionGrant[];
  regionStates: ReadonlyMap<string, RegionState>;
  leases: readonly Lease[];
  documentState: DocumentState;
  /** Whether an active workflow lets participants fill while the document is locked (07 §4 limit 1; 12 §6). */
  workflowActive: boolean;
  /** The binding of each approved region (07 §11), when the store keeps it. */
  approvals?: ReadonlyMap<string, RegionApproval>;
}

export const EMPTY_PERMISSIONS: PermissionState = {
  revision: 0,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
};
