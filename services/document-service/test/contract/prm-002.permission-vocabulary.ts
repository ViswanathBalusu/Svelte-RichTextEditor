// PRM-002 criterion 3 (07 §3): what counts as permission data, and an enumeration of every
// attribute the CDM schema lets a document hold. Shared by the schema test
// (prm-002.schema.test.ts) and the storage round trip (prm-002.content-checks.ts).
import {
  CAPABILITIES,
  DOC_ROLES,
  REGION_POLICIES,
  REGION_ROLES,
  type DocumentState,
  type RegionState,
} from '@docedit/authority';
import type { CdmDefinition, Grammar } from '@docedit/model/definition';

/** Region states (07 §11) and document states (07 §9): permission data kept in the database. */
export const REGION_STATES = [
  'draft',
  'in_review',
  'approved',
] as const satisfies readonly RegionState[];
export const DOCUMENT_STATES = [
  'active',
  'locked',
  'archived',
] as const satisfies readonly DocumentState[];

/**
 * Words that name permission data of 07 §3 (document role, groups, grants, region states, leases,
 * workflow participants) or the vocabulary of 07 §1, §2 and §4. An attribute or key is matched on
 * whole words of its name (`expiresAt` is `expires` + `at`), so `placeholder` is not `holder`.
 */
export const PERMISSION_WORDS: ReadonlySet<string> = new Set([
  'access',
  'acl',
  'approval',
  'approvals',
  'capabilities',
  'capability',
  'docs',
  'expires',
  'expiry',
  'grant',
  'grants',
  'grp',
  'holder',
  'lease',
  'leases',
  'owner',
  'owners',
  'participant',
  'participants',
  'permission',
  'permissions',
  'policies',
  'policy',
  'principal',
  'principals',
  'role',
  'roles',
  'state',
  'states',
]);

/** Values that only permission data takes: capabilities, roles, states, policies, `everyone`. */
export const PERMISSION_VALUES: ReadonlySet<string> = new Set<string>([
  ...CAPABILITIES,
  ...DOC_ROLES,
  ...REGION_ROLES,
  ...REGION_POLICIES,
  ...REGION_STATES,
  ...DOCUMENT_STATES,
  'everyone',
]);

/** Principal forms of 07 §2: a grant names one of these. */
export const PRINCIPAL_SAMPLES = [
  'user:dave',
  'group:legal',
  'role:role_tenant',
  'everyone',
] as const;

/** The whole words of a name: split at case changes, digits, `_`, `-`, `.` and `:`. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

export function isPermissionName(name: string): boolean {
  return nameWords(name).some((w) => PERMISSION_WORDS.has(w));
}

/** One attribute of a node or mark type, or a member nested in an object or array attribute. */
export interface SchemaAttribute {
  kind: 'node' | 'mark' | 'projection';
  type: string;
  /** `policy`, or `levels[].runProps.lang` for a nested member. */
  path: string;
  /** The last name in `path`. */
  name: string;
  grammar: Grammar;
}

/** Every attribute of every node, mark and projection node type, with nested members. */
export function schemaAttributes(def: CdmDefinition): SchemaAttribute[] {
  const out: SchemaAttribute[] = [];
  const visit = (
    kind: SchemaAttribute['kind'],
    type: string,
    path: string,
    name: string,
    g: Grammar,
  ): void => {
    out.push({ kind, type, path, name, grammar: g });
    if (g.kind === 'object')
      for (const [k, v] of Object.entries(g.properties)) visit(kind, type, `${path}.${k}`, k, v);
    if (g.kind === 'array') visitItems(kind, type, `${path}[]`, g.items);
  };
  const visitItems = (
    kind: SchemaAttribute['kind'],
    type: string,
    path: string,
    g: Grammar,
  ): void => {
    if (g.kind === 'object')
      for (const [k, v] of Object.entries(g.properties)) visit(kind, type, `${path}.${k}`, k, v);
    if (g.kind === 'array') visitItems(kind, type, `${path}[]`, g.items);
  };
  for (const n of def.nodes)
    for (const [k, a] of Object.entries(n.attrs)) visit('node', n.name, k, k, a.grammar);
  for (const m of def.marks)
    for (const [k, a] of Object.entries(m.attrs)) visit('mark', m.name, k, k, a.grammar);
  for (const p of def.projection ?? [])
    for (const [k, a] of Object.entries(p.attrs)) visit('projection', p.name, k, k, a.grammar);
  return out;
}

/** Why an attribute looks permission-related; empty when it does not. */
export function permissionSignals(a: SchemaAttribute): string[] {
  const why: string[] = [];
  if (isPermissionName(a.name)) why.push('name');
  if (a.grammar.kind === 'enum' && a.grammar.values.some((v) => PERMISSION_VALUES.has(v)))
    why.push('values');
  if (a.grammar.kind === 'ref' && a.grammar.to === 'role') why.push('role reference');
  return why;
}

/** `type.path` of every attribute with a permission signal, with the signals. */
export function permissionRelated(def: CdmDefinition): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const a of schemaAttributes(def)) {
    const why = permissionSignals(a);
    if (why.length > 0) found.set(`${a.type}.${a.path}`, why);
  }
  return found;
}

/** Every key of every object reachable from `value`, in document order, with repeats. */
export function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

/** Every `{ type, attrs }` object reachable from `value`: the nodes and marks of CDM JSON. */
export function typedAttrs(
  value: unknown,
  out: Array<{ type: string; attrs: Record<string, unknown> }> = [],
): Array<{ type: string; attrs: Record<string, unknown> }> {
  if (Array.isArray(value)) {
    for (const v of value) typedAttrs(v, out);
  } else if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (
      typeof rec['type'] === 'string' &&
      rec['attrs'] !== null &&
      typeof rec['attrs'] === 'object'
    )
      out.push({ type: rec['type'], attrs: rec['attrs'] as Record<string, unknown> });
    for (const v of Object.values(rec)) typedAttrs(v, out);
  }
  return out;
}
