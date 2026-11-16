/**
 * Permission data in PostgreSQL (07 §3, §9; 06 §3; BE-010, BE-026; PRM-002).
 *
 * A change is one transaction that raises the grants revision first, which also waits for any log
 * write that holds the revision row, then changes the rows and records the whole state in force
 * at the new revision in grant_history. Log writes compare the revision their batch was checked
 * against with this row, so a change whose notification to the room is lost still stops every
 * commit checked against the old permissions (04 G7). The room records the control commit when
 * it learns of the revision (07 §9), through the notification or through `revision_moved`.
 *
 * Every change is audited in its own transaction (07 §14; PRM-051 criterion 3; BE-014 criterion
 * 3): an `audit_events` row with the actor, the document, the scopes the change touched and the
 * server time, inserted with the data plane's `insertAuditEvent` (migration 0031, packet A).
 */
import type {
  DocumentState,
  Lease,
  PermissionState,
  RegionApproval,
  RegionGrant,
  RegionState,
} from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { insertAuditEvent } from '../data-plane/pg/audit.ts';
import { diffPermissions } from './permission-change.ts';
import {
  constraintOf,
  inTenant,
  int,
  iso,
  millis,
  sqlState,
  SQLSTATE,
  type Pool,
  type Queryable,
} from './db.ts';
import {
  DocumentNotFoundError,
  RetiredRegionError,
  RevisionConflictError,
  type ChangeOptions,
  type DocRef,
  type GrantStore,
  type PermissionChange,
} from './types.ts';

/** The JSON form of a permission state in grant_history. */
interface StoredState {
  grants: RegionGrant[];
  regionStates: Array<[string, RegionState]>;
  /** The approval bindings (PRM-046); absent in records written before them. */
  approvals?: Array<[string, RegionApproval]>;
  leases: Lease[];
  documentState: DocumentState;
  workflowActive: boolean;
}

function toJson(p: PermissionState): StoredState {
  return {
    grants: p.grants.map((g) => ({
      region: g.region,
      principal: g.principal,
      role: g.role,
      expiresAt: g.expiresAt,
    })),
    regionStates: [...p.regionStates.entries()],
    ...(p.approvals?.size ? { approvals: [...p.approvals.entries()] } : {}),
    // The lease's id and acquisition time are kept too, so that a state read back from history
    // equals the one `change` returns (BE-010 notes; contract checks "grants ... round-trip").
    leases: p.leases.map((l) => ({
      region: l.region,
      holder: l.holder,
      expiresAt: l.expiresAt,
      ...(l.id !== undefined ? { id: l.id } : {}),
      ...(l.acquiredAt !== undefined ? { acquiredAt: l.acquiredAt } : {}),
    })),
    documentState: p.documentState,
    workflowActive: p.workflowActive,
  };
}

function fromJson(revision: number, s: StoredState): PermissionState {
  return {
    revision,
    grants: s.grants,
    regionStates: new Map(s.regionStates),
    ...(s.approvals?.length ? { approvals: new Map(s.approvals) } : {}),
    leases: s.leases,
    documentState: s.documentState,
    workflowActive: s.workflowActive,
  };
}

/** The state in force now, read from the relational rows inside the caller's transaction. */
export async function readPermissions(c: Queryable, doc: string): Promise<PermissionState> {
  const head = await c.query<{ rev: string; workflow_active: boolean; state: DocumentState }>(
    `SELECT g.rev, g.workflow_active, d.state
       FROM grant_revisions g JOIN documents d ON d.id = g.doc_id
      WHERE g.doc_id = $1`,
    [doc],
  );
  const h = head.rows[0];
  if (!h) throw new DocumentNotFoundError(`no document ${doc}`);
  const grants = await c.query<{
    region_id: string;
    principal: string;
    role: RegionGrant['role'];
    expires_at: Date | null;
  }>(
    `SELECT region_id, principal, role, expires_at FROM region_grants WHERE doc_id = $1
      ORDER BY region_id COLLATE "C", principal COLLATE "C"`,
    [doc],
  );
  const states = await c.query<{
    region_id: string;
    state: RegionState;
    approved_seq: string | null;
    content_hash: string | null;
  }>(
    `SELECT region_id, state, approved_seq, encode(content_hash, 'hex') AS content_hash
       FROM region_states WHERE doc_id = $1 ORDER BY region_id COLLATE "C"`,
    [doc],
  );
  const approvals = new Map<string, RegionApproval>();
  for (const s of states.rows)
    if (s.approved_seq !== null && s.content_hash !== null)
      approvals.set(s.region_id, { seq: int(s.approved_seq), hash: s.content_hash });
  const leases = await c.query<{
    region_id: string;
    holder: string;
    expires_at: Date;
    lease_id: string;
    acquired_at: Date;
  }>(
    `SELECT region_id, holder, expires_at, lease_id, acquired_at FROM region_leases WHERE doc_id = $1
      ORDER BY region_id COLLATE "C"`,
    [doc],
  );
  return {
    revision: int(h.rev),
    grants: grants.rows.map((g) => ({
      region: g.region_id,
      principal: g.principal,
      role: g.role,
      expiresAt: millis(g.expires_at),
    })),
    regionStates: new Map(states.rows.map((s) => [s.region_id, s.state])),
    ...(approvals.size ? { approvals } : {}),
    leases: leases.rows.map((l) => ({
      region: l.region_id,
      holder: l.holder,
      expiresAt: millis(l.expires_at)!,
      id: l.lease_id,
      acquiredAt: millis(l.acquired_at)!,
    })),
    documentState: h.state,
    workflowActive: h.workflow_active,
  };
}

/** Applies the row changes of `change` (not the revision) inside the caller's transaction. */
export async function applyPermissionRows(
  c: Queryable,
  ref: DocRef,
  change: PermissionChange,
  actor: string,
): Promise<void> {
  const { doc, tenant } = ref;
  if (change.removeGrants?.length)
    await c.query(
      `DELETE FROM region_grants g USING unnest($2::text[], $3::text[]) AS x(region_id, principal)
        WHERE g.doc_id = $1 AND g.region_id = x.region_id AND g.principal = x.principal`,
      [doc, change.removeGrants.map((g) => g.region), change.removeGrants.map((g) => g.principal)],
    );
  if (change.putGrants?.length) {
    const g = change.putGrants;
    await c.query(
      `INSERT INTO region_grants (doc_id, region_id, principal, tenant_id, role, expires_at,
                                  created_by, created_at)
       SELECT $1, x.region_id, x.principal, $2, x.role, x.expires_at, $7, now()
         FROM unnest($3::text[], $4::text[], $5::text[], $6::timestamptz[])
           AS x(region_id, principal, role, expires_at)
       ON CONFLICT (doc_id, region_id, principal) DO UPDATE
          SET role = excluded.role, expires_at = excluded.expires_at,
              created_by = excluded.created_by, created_at = excluded.created_at`,
      [
        doc,
        tenant,
        g.map((x) => x.region),
        g.map((x) => x.principal),
        g.map((x) => x.role),
        g.map((x) => (x.expiresAt === null ? null : iso(x.expiresAt))),
        actor,
      ],
    );
  }
  if (change.clearRegionStates?.length)
    await c.query('DELETE FROM region_states WHERE doc_id = $1 AND region_id = ANY ($2::text[])', [
      doc,
      change.clearRegionStates,
    ]);
  if (change.setRegionStates?.length) {
    const s = change.setRegionStates;
    // An approval keeps its binding (PRM-046); any other state clears it, so the columns are null.
    await c.query(
      `INSERT INTO region_states (doc_id, region_id, tenant_id, state, changed_by, changed_at,
                                  approved_seq, content_hash)
       SELECT $1, x.region_id, $2, x.state, $5, now(), x.approved_seq,
              decode(x.content_hash, 'hex')
         FROM unnest($3::text[], $4::text[], $6::bigint[], $7::text[])
           AS x(region_id, state, approved_seq, content_hash)
       ON CONFLICT (doc_id, region_id) DO UPDATE
          SET state = excluded.state, changed_by = excluded.changed_by,
              changed_at = excluded.changed_at, approved_seq = excluded.approved_seq,
              content_hash = excluded.content_hash`,
      [
        doc,
        tenant,
        s.map((x) => x.region),
        s.map((x) => x.state),
        actor,
        s.map((x) => x.approval?.seq ?? null),
        s.map((x) => x.approval?.hash ?? null),
      ],
    );
  }
  if (change.removeLeases?.length)
    await c.query('DELETE FROM region_leases WHERE doc_id = $1 AND region_id = ANY ($2::text[])', [
      doc,
      change.removeLeases,
    ]);
  if (change.putLeases?.length) {
    const l = change.putLeases;
    await c.query(
      `INSERT INTO region_leases (doc_id, region_id, tenant_id, lease_id, holder, acquired_at,
                                  expires_at)
       SELECT $1, x.region_id, $2, COALESCE(x.lease_id::uuid, gen_random_uuid()), x.holder,
              COALESCE(x.acquired_at, now()), x.expires_at
         FROM unnest($3::text[], $4::text[], $5::timestamptz[], $6::text[], $7::timestamptz[])
              AS x(region_id, holder, expires_at, lease_id, acquired_at)
       ON CONFLICT (doc_id, region_id) DO UPDATE
          SET lease_id = excluded.lease_id, holder = excluded.holder,
              acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
      [
        doc,
        tenant,
        l.map((x) => x.region),
        l.map((x) => x.holder),
        l.map((x) => iso(x.expiresAt)),
        // The authority's identifier and acquisition time are kept: a heartbeat must not restart
        // the eight-hour maximum (PRM-044). Legacy callers without them get a fresh identifier.
        l.map((x) => x.id ?? null),
        l.map((x) => (x.acquiredAt === undefined ? null : iso(x.acquiredAt))),
      ],
    );
  }
  if (change.documentState !== undefined)
    await c.query('UPDATE documents SET state = $2 WHERE id = $1', [doc, change.documentState]);
}

/** Records the state in force at `revision` (inside the caller's transaction). */
export async function recordRevision(
  c: Queryable,
  ref: DocRef,
  state: PermissionState,
  actor: string,
): Promise<void> {
  await c.query(
    `INSERT INTO grant_history (doc_id, rev, tenant_id, state, changed_by, changed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now())`,
    [ref.doc, state.revision, ref.tenant, JSON.stringify(toJson(state)), actor],
  );
}

/** Maps the retired-region trigger's refusal to its own error type. */
export function translateGrantError(e: unknown): unknown {
  if (sqlState(e) === SQLSTATE.checkViolation && constraintOf(e) === 'region_not_retired')
    return new RetiredRegionError(e instanceof Error ? e.message : String(e));
  return e;
}

/** The scopes a change touches, for its audit entry (PRM-051 criterion 3): regions and `doc`. */
export function changedScopes(change: PermissionChange): string[] {
  const regions = new Set<string>([
    ...(change.putGrants ?? []).map((g) => g.region),
    ...(change.removeGrants ?? []).map((g) => g.region),
    ...(change.setRegionStates ?? []).map((s) => s.region),
    ...(change.clearRegionStates ?? []),
    ...(change.putLeases ?? []).map((l) => l.region),
    ...(change.removeLeases ?? []),
  ]);
  const scopes = [...regions].sort().map((r) => `region:${r}`);
  if (change.documentState !== undefined || change.workflowActive !== undefined)
    scopes.unshift('doc');
  return scopes;
}

// `diffPermissions` is plain data work and lives in permission-change.ts; it stays exported from here.
export { diffPermissions };

export class PgGrantStore implements GrantStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  current(ref: DocRef): Promise<PermissionState> {
    return inTenant(this.#pool, ref.tenant, (c) => readPermissions(c, ref.doc), { readOnly: true });
  }

  at(ref: DocRef, revision: number): Promise<PermissionState | null> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<{ state: StoredState }>(
          'SELECT state FROM grant_history WHERE doc_id = $1 AND rev = $2',
          [ref.doc, revision],
        );
        const row = r.rows[0];
        return row ? fromJson(revision, row.state) : null;
      },
      { readOnly: true },
    );
  }

  history(ref: DocRef): Promise<PermissionState[]> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<{ rev: string; state: StoredState }>(
          'SELECT rev, state FROM grant_history WHERE doc_id = $1 ORDER BY rev',
          [ref.doc],
        );
        return r.rows.map((row) => fromJson(int(row.rev), row.state));
      },
      { readOnly: true },
    );
  }

  retired(ref: DocRef): Promise<string[]> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<{ region_id: string }>(
          'SELECT region_id FROM retired_regions WHERE doc_id = $1 ORDER BY region_id COLLATE "C"',
          [ref.doc],
        );
        return r.rows.map((row) => row.region_id);
      },
      { readOnly: true },
    );
  }

  async change(
    ref: DocRef,
    change: PermissionChange,
    opts: ChangeOptions,
  ): Promise<PermissionState> {
    try {
      return await inTenant(this.#pool, ref.tenant, async (c) => {
        // The revision first: the row lock waits for any log write that holds it for share.
        const r = await c.query<{ rev: string }>(
          `UPDATE grant_revisions
              SET rev = rev + 1, workflow_active = coalesce($2, workflow_active)
            WHERE doc_id = $1 AND ($3::bigint IS NULL OR rev = $3)
            RETURNING rev`,
          [ref.doc, change.workflowActive ?? null, opts.ifRevision ?? null],
        );
        if (r.rowCount !== 1) {
          const cur = await c.query<{ rev: string }>(
            'SELECT rev FROM grant_revisions WHERE doc_id = $1',
            [ref.doc],
          );
          const row = cur.rows[0];
          if (!row) throw new DocumentNotFoundError(`no document ${ref.doc}`);
          throw new RevisionConflictError(
            `the grants revision is ${row.rev}, not ${String(opts.ifRevision)}`,
            int(row.rev),
          );
        }
        await applyPermissionRows(c, ref, change, opts.actor);
        const state = await readPermissions(c, ref.doc);
        await recordRevision(c, ref, state, opts.actor);
        // The audit entry commits with the change or not at all (BE-014 criterion 3).
        await insertAuditEvent(c, {
          id: uuid7(),
          tenant: ref.tenant,
          doc: ref.doc,
          actor: opts.actor,
          kind: 'grants.changed',
          data: {
            rev: state.revision,
            scopes: changedScopes(change),
            ...(change.documentState !== undefined ? { documentState: change.documentState } : {}),
          },
          at: Date.now(),
        });
        return state;
      });
    } catch (e) {
      throw translateGrantError(e);
    }
  }
}
