/**
 * The authorisation matrix of 07 §12 as data (PRM-056): for each of its 13 rows the operation, the
 * DEP routes and messages it covers, and what it requires. Guards evaluate a row with `authorise`
 * and keep no copy of a requirement. Routes the matrix has no row for are listed with a documented
 * classification instead: `public` (no credential), `fields` (12 §10, whose requirements 12 states)
 * or `open` (07 §12 is silent; PRM-056 Notes), so that a route never ships unclassified.
 */
import { type Access, holdsSomewhere } from './access.ts';
import type { Capability, OperationId, RegionState } from './model.ts';

export type Requirement =
  /** The capability in the document, in at least one scope, in every target scope, or in a region. */
  | {
      kind: 'capability';
      any: readonly Capability[];
      where: 'document' | 'somewhere' | 'targets' | 'region';
    }
  /** The outcome check of 07 §5. */
  | { kind: 'commit' }
  /** `manage`, a document-level capability (07 §2). */
  | { kind: 'manage'; operations: readonly OperationId[] }
  /** A service credential (05 §3.2); a user token never becomes one. */
  | { kind: 'service' };

export interface MatrixRow {
  /** Position in 07 §12, from 1. */
  row: number;
  id: string;
  operation: string;
  requirement: Requirement;
  /** Further conditions of the row, in the words of 07. */
  conditions: readonly string[];
  routes: readonly string[];
  messages: readonly string[];
}

const cap = (
  any: readonly Capability[],
  where: 'document' | 'somewhere' | 'targets' | 'region',
): Requirement => ({ kind: 'capability', any, where });

export const MATRIX: readonly MatrixRow[] = [
  {
    row: 1,
    id: 'read.head',
    operation: 'Open a channel, read content at the head, presence',
    requirement: cap(['view'], 'document'),
    conditions: ['content of hidden regions and values is projected away (ADR 0019)'],
    routes: ['GET /documents/{id}/content'],
    messages: ['ch.open', 'presence.update'],
  },
  {
    row: 2,
    id: 'read.history',
    operation: 'Content, history, comparison, attribution, commits at an earlier `seq`',
    requirement: cap(['view'], 'document'),
    conditions: ['the history gate `minVisibleSeq` (07 §8)'],
    routes: [
      'GET /documents/{id}/content',
      'GET /documents/{id}/commits',
      'GET /documents/{id}/history',
      'GET /documents/{id}/versions',
      'GET /documents/{id}/diff',
      'GET /documents/{id}/attribution',
    ],
    messages: ['ch.open'],
  },
  {
    row: 3,
    id: 'commit',
    operation: 'Submit a commit',
    requirement: { kind: 'commit' },
    conditions: ['07 §5'],
    routes: [],
    messages: ['sync.submit'],
  },
  {
    row: 4,
    id: 'thread.create',
    operation: 'Create a thread, reply',
    requirement: cap(['comment'], 'targets'),
    conditions: ['`comment` in the scopes of the target'],
    routes: ['POST /documents/{id}/threads', 'POST /threads/{tid}/comments'],
    messages: [],
  },
  {
    row: 5,
    id: 'thread.update',
    operation: 'Resolve, reopen or assign a thread',
    requirement: cap(['comment'], 'targets'),
    conditions: ['`comment` in its scope', 'delete needs the author or `manage`'],
    routes: ['PATCH /threads/{tid}', 'DELETE /threads/{tid}'],
    messages: [],
  },
  {
    row: 6,
    id: 'asset.upload',
    operation: 'Upload an asset',
    requirement: cap(['edit', 'suggest', 'fill'], 'somewhere'),
    conditions: [],
    routes: ['POST /documents/{id}/assets', 'POST /assets/{aid}/complete'],
    messages: [],
  },
  {
    row: 7,
    id: 'asset.read',
    operation: 'Read an asset',
    requirement: cap(['view'], 'document'),
    conditions: ['on a document the asset is attached to'],
    routes: [],
    messages: [],
  },
  {
    row: 8,
    id: 'version.create',
    operation: 'Named version',
    requirement: cap(['edit'], 'somewhere'),
    conditions: [],
    routes: ['POST /documents/{id}/versions'],
    messages: [],
  },
  {
    row: 9,
    id: 'restore.region',
    operation: 'Restore a region',
    requirement: cap(['edit'], 'region'),
    conditions: ['not approved', 'not leased to someone else'],
    routes: ['POST /documents/{id}/restore'],
    messages: [],
  },
  {
    row: 10,
    id: 'manage',
    operation:
      'Restore a document, grants, region state or policy, break a lease, workflow actions, delete',
    requirement: {
      kind: 'manage',
      operations: [
        'document.restore',
        'grants.change',
        'region_state.change',
        'region.policy',
        'lease.break',
        'workflow.action',
        'document.delete',
      ],
    },
    conditions: [],
    routes: [
      'POST /documents/{id}/restore',
      'PATCH /documents/{id}/grants',
      'PUT /documents/{id}/regions/{rid}/state',
      'DELETE /documents/{id}/regions/{rid}/lease',
      'PUT /documents/{id}/workflow',
      'POST /documents/{id}/workflow/send',
      'DELETE /documents/{id}',
    ],
    messages: [],
  },
  {
    row: 11,
    id: 'lease.acquire',
    operation: 'Acquire a lease',
    requirement: cap(['edit'], 'region'),
    conditions: [],
    routes: ['POST /documents/{id}/regions/{rid}/lease'],
    messages: [],
  },
  {
    row: 12,
    id: 'export',
    operation: 'Export',
    requirement: cap(['view'], 'document'),
    conditions: ['unless restricted with `no-export`', 'raw compile logs need `edit`'],
    routes: ['POST /documents/{id}/exports', 'GET /exports/{jid}'],
    messages: [],
  },
  {
    row: 13,
    id: 'service',
    operation:
      'Import, fork, create, list, search, audit, webhooks, tokens, revoke, retention, holds',
    requirement: { kind: 'service' },
    conditions: [],
    routes: [
      // Retention policies (08 §11; UX-080): set and read with a service credential.
      'GET /retention',
      'PUT /retention',
      'GET /documents/{id}/retention',
      'PUT /documents/{id}/retention',
      // Legal holds (08 §11; UX-080 criteria 2 and 3): place and list with a service credential.
      'POST /documents/{id}/holds',
      'GET /holds',
      // Tenant quotas (06 §12; UX-078 criterion 1): read and set with a service credential.
      'GET /quotas',
      'PUT /quotas',
      // The tenant's allowed origins and public keys, read with a service credential (UX-077 criterion 4).
      'GET /origins',
      'GET /keys',
      // The registration and removal of a key or an origin, with a service credential (UX-077 criterion 5).
      'POST /origins',
      'DELETE /origins/{origin}',
      'POST /keys',
      'DELETE /keys/{kid}',
      'POST /documents/{id}/imports',
      'PUT /documents/{id}/content',
      'POST /documents/{id}/fork',
      'POST /documents',
      'GET /documents',
      'GET /search',
      'GET /audit',
      'GET /webhooks',
      'POST /webhooks',
      'GET /webhooks/{id}',
      'PATCH /webhooks/{id}',
      'DELETE /webhooks/{id}',
      'POST /tokens',
      'POST /sessions/revoke',
    ],
    messages: [],
  },
];

export interface RouteClassification {
  route: string;
  class: 'public' | 'fields' | 'open';
  note: string;
}

const open = (route: string, note: string): RouteClassification => ({ route, class: 'open', note });
const fields = (route: string, note: string): RouteClassification => ({
  route,
  class: 'fields',
  note,
});

/** Routes with no row in 07 §12, classified. `open` ones are owner or PRO questions (PRM-056). */
export const UNMATRIXED_ROUTES: readonly RouteClassification[] = [
  {
    route: 'GET /.well-known/dep',
    class: 'public',
    note: 'discovery, without credentials (05 §2)',
  },
  open('GET /documents/{id}', 'metadata and state: no row'),
  open('PATCH /documents/{id}', "changing a document's state: no row"),
  open('GET /documents/{id}/regions', 'reading regions: no row (PRM-032 assumes `view`)'),
  open('GET /documents/{id}/grants', 'reading grants: no row'),
  open('PUT /documents/{id}/regions/{rid}/lease', 'a heartbeat by the holder (07 §10): no row'),
  open('PUT /documents/{id}/read-marker', 'read markers: no row'),
  open('GET /documents/{id}/activity', 'activity: no row'),
  open('GET /documents/{id}/threads', 'reading threads: no row'),
  open('GET /threads/{tid}', 'reading a thread: no row'),
  open('PATCH /comments/{cid}', 'editing a comment: no row'),
  open('DELETE /comments/{cid}', 'deleting a comment: no row (row 5 names threads)'),
  open('POST /documents/{id}/assets/resolve', 'resolving asset URLs: no row'),
  open('DELETE /exports/{jid}', 'deleting an export: no row'),
  open('GET /imports/{jid}', 'reading an import job: no row'),
  open('GET /fonts', 'the font manifest: no row'),
  fields('GET /documents/{id}/fields', '12 §10'),
  fields('GET /documents/{id}/field-values', '12 §10; values projected per reader (ADR 0019)'),
  fields('PATCH /documents/{id}/field-values', '12 §9 prefill: a server-authored commit'),
  fields('GET /documents/{id}/workflow', '12 §6'),
  fields('POST /documents/{id}/workflow/participants/{pid}/consent', '12 §7, §8.1'),
  fields('POST /documents/{id}/workflow/participants/{pid}/verify', '12 §7'),
  fields('POST /documents/{id}/workflow/participants/{pid}/complete', '12 §8.1'),
  fields('POST /documents/{id}/workflow/participants/{pid}/decline', '12 §6.2'),
  fields('POST /documents/{id}/fields/{fid}/sign', '12 §8.1: P7 conditions, then origin `sign`'),
  fields('GET /documents/{id}/workflow/evidence', '12 §7'),
  fields('GET /documents/{id}/workflow/final', '12 §8.2'),
];

export interface MatrixContext {
  credential: 'user' | 'service';
  /** The caller's effective access (user tokens). */
  access?: Access;
  /** Rows 4 and 5: the scopes the target covers. */
  targets?: readonly string[];
  /** Rows 9 and 11: the region. */
  region?: string;
  regionState?: RegionState;
  leasedToSomeoneElse?: boolean;
  /** The token's `restrict` claim (05 §3.1). */
  restrictions?: readonly string[];
}

export type MatrixVerdict = { ok: true } | { ok: false; reason: string };

const capsIn = (a: Access, scope: string) =>
  scope === 'body'
    ? a.body
    : scope.startsWith('region:')
      ? (a.regions.get(scope.slice(7)) ?? new Set<Capability>())
      : a.structureScopes;

/** Whether a caller meets a row's requirement (07 §12). Gates such as `minVisibleSeq` are separate. */
export function authorise(rowId: string, ctx: MatrixContext): MatrixVerdict {
  const row = MATRIX.find((r) => r.id === rowId);
  if (!row) return { ok: false, reason: `no matrix row ${rowId}` };
  const req = row.requirement;
  if (req.kind === 'service')
    return ctx.credential === 'service'
      ? { ok: true }
      : { ok: false, reason: 'needs a service credential' };
  const a = ctx.access;
  if (!a) return { ok: false, reason: 'needs a user with access to the document' };
  if (req.kind === 'commit') return { ok: true }; // decided per commit by the outcome check
  if (req.kind === 'manage')
    return a.docRole.has('manage') ? { ok: true } : { ok: false, reason: 'needs `manage`' };
  if (row.id === 'export' && ctx.restrictions?.includes('no-export'))
    return { ok: false, reason: 'restricted with `no-export`' };
  const has = (c: Capability) => {
    switch (req.where) {
      case 'document':
        return a.docRole.has(c);
      case 'somewhere':
        return holdsSomewhere(a, c);
      case 'targets':
        return (
          (ctx.targets ?? []).length > 0 && (ctx.targets ?? []).every((s) => capsIn(a, s).has(c))
        );
      case 'region':
        return ctx.region !== undefined && (a.regions.get(ctx.region)?.has(c) ?? false);
    }
  };
  if (!req.any.some(has))
    return { ok: false, reason: `needs ${req.any.map((c) => `\`${c}\``).join(' or ')}` };
  if (row.id === 'restore.region' && ctx.regionState === 'approved')
    return { ok: false, reason: 'the region is approved' };
  if (row.id === 'restore.region' && ctx.leasedToSomeoneElse)
    return { ok: false, reason: 'the region is leased to someone else' };
  return { ok: true };
}
