/**
 * The workflow resource of a document in PostgreSQL (FRW-025 criteria 2, 3 and 5; FRW-026 criteria 1
 * and 4; migration 0070 `workflow_resource`; lane V-FRW-019-036).
 *
 * - `create` makes the one workflow of a document. A second one for the same document is refused as
 *   `exists` (version 1 has one workflow per document, criterion 2).
 * - `replaceParticipants` is the write behind `PUT /documents/{id}/workflow`: the caller must hold
 *   `manage`; the workflow must be `draft` (any other state is refused as `workflow_active`, criterion
 *   3); the revision the caller read must be the stored one (`If-Match`, else `precondition_failed`);
 *   and the list must pass `checkParticipants` (kinds, order, roles and members, criterion 4 of
 *   FRW-026 through the stored shape). Only then is the list written and the revision advanced.
 * - `read` returns the resource with its ETag, which is the revision as a quoted string.
 *
 * - `put` is the write behind the route (FRW-025, workflow-routes.ts): it also sets the time zone and
 *   the other writable members (`routing`, `deadline`, `reminders`, `consent`, `finalisation`).
 *
 * Not built here: the state changes of the actions (`send` and the rest). The caller's `manage` is
 * passed in to `create` and `replaceParticipants`; the route checks it before it calls `put`.
 */
import { uuid7 } from '@docedit/model';
import {
  checkParticipants,
  type ParticipantProblem,
  type WorkflowInput,
  type WorkflowMembers,
} from '@docedit/authority';
import { inTenant, type Pool, type Queryable } from '../storage/db.ts';
import {
  etagOfRevision,
  type WorkflowPutResult,
  type WorkflowResourceStore,
  type WorkflowResourceView,
  type WorkflowTransitionResult,
  type WorkflowTransitionWrite,
} from './workflow-resource.ts';

export type { WorkflowResourceView } from './workflow-resource.ts';

export const WORKFLOW_RESOURCE_TABLE = 'workflow_resource';

/** The caller's right: `manage` is the right of 07 §4 that owns the workflow. */
export interface ResourceCaller {
  readonly manage: boolean;
}

export type WorkflowResourceProblem =
  | { readonly code: 'forbidden' }
  | { readonly code: 'exists' }
  | { readonly code: 'not_found' }
  | { readonly code: 'workflow_active'; readonly state: string }
  | { readonly code: 'precondition_failed'; readonly rev: number }
  | { readonly code: 'invalid_participants'; readonly problems: readonly ParticipantProblem[] };

export type WorkflowResourceResult =
  | { readonly ok: true; readonly resource: WorkflowResourceView }
  | { readonly ok: false; readonly problem: WorkflowResourceProblem };

export interface CreateOptions {
  readonly timeZone: string;
}

interface Row {
  id: string;
  doc_id: string;
  state: string;
  rev: number;
  time_zone: string;
  participants: unknown;
  sent_seq: string | number | null;
  sent_hash: string | null;
  members: unknown;
}

/** The columns every statement of this store selects or returns. */
const COLUMNS = 'id, doc_id, state, rev, time_zone, participants, sent_seq, sent_hash, members';

/**
 * The stored participants: the drafts of `checkParticipants`, and the members the server adds once
 * the workflow runs (`state`, `completedSeq`), which the writer's check does not accept.
 */
function participantsOf(stored: unknown): WorkflowResourceView['participants'] {
  if (!Array.isArray(stored)) return [];
  const own = (p: unknown): Record<string, unknown> =>
    typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
  const drafts = stored.map((p) => {
    const {
      state: _state,
      completedSeq: _completedSeq,
      firstViewedAt: _firstViewedAt,
      activatedAt: _activatedAt,
      verifiedAt: _verifiedAt,
      skippedBy: _skippedBy,
      addedBy: _addedBy,
      ...draft
    } = own(p);
    return draft;
  });
  const checked = checkParticipants(drafts);
  if (!checked.ok) return [];
  return checked.participants.map((draft, i) => {
    const { state, completedSeq, firstViewedAt, activatedAt, verifiedAt, skippedBy, addedBy } = own(
      stored[i],
    );
    return {
      ...draft,
      ...(typeof state === 'string' ? { state } : {}),
      ...(typeof completedSeq === 'number' ? { completedSeq } : {}),
      ...(typeof firstViewedAt === 'string' ? { firstViewedAt } : {}),
      ...(typeof activatedAt === 'string' ? { activatedAt } : {}),
      ...(typeof verifiedAt === 'string' ? { verifiedAt } : {}),
      ...(typeof skippedBy === 'number' ? { skippedBy } : {}),
      ...(typeof addedBy === 'number' ? { addedBy } : {}),
    };
  });
}

function viewOf(row: Row): WorkflowResourceView {
  const participants = participantsOf(row.participants);
  return {
    id: row.id,
    doc: row.doc_id,
    state: row.state,
    rev: row.rev,
    etag: etagOfRevision(row.rev),
    sentSeq: row.sent_seq === null ? null : Number(row.sent_seq),
    sentHash: row.sent_hash,
    timeZone: row.time_zone,
    participants,
    members: (row.members ?? {}) as WorkflowMembers,
  };
}

async function lockRow(c: Queryable, tenant: string, doc: string): Promise<Row | null> {
  const r = await c.query<Row>(
    `SELECT ${COLUMNS}
       FROM ${WORKFLOW_RESOURCE_TABLE}
      WHERE tenant_id = $1 AND doc_id = $2
      FOR UPDATE`,
    [tenant, doc],
  );
  return r.rows[0] ?? null;
}

export class PgWorkflowResourceStore implements WorkflowResourceStore {
  readonly #pool: Pool;
  readonly #now: () => number;

  constructor(pool: Pool, options: { now?: () => number } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? Date.now;
  }

  /** Makes the one workflow of a document, in state `draft` at revision 1, with no participants. */
  async create(
    tenant: string,
    doc: string,
    caller: ResourceCaller,
    options: CreateOptions,
  ): Promise<WorkflowResourceResult> {
    if (!caller.manage) return { ok: false, problem: { code: 'forbidden' } };
    const at = new Date(this.#now()).toISOString();
    const id = uuid7();
    const inserted = await inTenant(this.#pool, tenant, (c) =>
      c.query<Row>(
        `INSERT INTO ${WORKFLOW_RESOURCE_TABLE}
           (tenant_id, doc_id, id, state, rev, time_zone, participants, created_at, updated_at)
         VALUES ($1, $2, $3, 'draft', 1, $4, '[]'::jsonb, $5, $5)
         ON CONFLICT (tenant_id, doc_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [tenant, doc, id, options.timeZone, at],
      ),
    );
    const row = inserted.rows[0];
    if (row === undefined) return { ok: false, problem: { code: 'exists' } };
    return { ok: true, resource: viewOf(row) };
  }

  /** The tenant's workflows that are `sent` or `in_progress`, for the scheduled sweep (FRW-034). */
  listRunning(tenant: string): Promise<readonly WorkflowResourceView[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLUMNS}
             FROM ${WORKFLOW_RESOURCE_TABLE}
            WHERE tenant_id = $1 AND state IN ('sent', 'in_progress')
            ORDER BY doc_id`,
          [tenant],
        );
        return r.rows.map(viewOf);
      },
      { readOnly: true },
    );
  }

  /** The resource of a document with its ETag, or null when the document has no workflow. */
  read(tenant: string, doc: string): Promise<WorkflowResourceView | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLUMNS}
             FROM ${WORKFLOW_RESOURCE_TABLE}
            WHERE tenant_id = $1 AND doc_id = $2`,
          [tenant, doc],
        );
        const row = r.rows[0];
        return row === undefined ? null : viewOf(row);
      },
      { readOnly: true },
    );
  }

  /**
   * Replaces the participant list of a `draft` workflow. `ifMatch` is the revision the caller read;
   * the list is written only when it is the stored one and the list passes `checkParticipants`.
   */
  replaceParticipants(
    tenant: string,
    doc: string,
    caller: ResourceCaller,
    ifMatch: number,
    input: unknown,
  ): Promise<WorkflowResourceResult> {
    if (!caller.manage) return Promise.resolve({ ok: false, problem: { code: 'forbidden' } });
    const at = new Date(this.#now()).toISOString();
    return inTenant(this.#pool, tenant, async (c): Promise<WorkflowResourceResult> => {
      const row = await lockRow(c, tenant, doc);
      if (row === null) return { ok: false, problem: { code: 'not_found' } };
      if (row.state !== 'draft')
        return { ok: false, problem: { code: 'workflow_active', state: row.state } };
      if (ifMatch !== row.rev)
        return { ok: false, problem: { code: 'precondition_failed', rev: row.rev } };
      const checked = checkParticipants(input);
      if (!checked.ok)
        return { ok: false, problem: { code: 'invalid_participants', problems: checked.problems } };
      const updated = await c.query<Row>(
        `UPDATE ${WORKFLOW_RESOURCE_TABLE}
            SET participants = $3::jsonb, rev = rev + 1, updated_at = $4
          WHERE tenant_id = $1 AND doc_id = $2
          RETURNING ${COLUMNS}`,
        [tenant, doc, JSON.stringify(checked.participants), at],
      );
      const next = updated.rows[0];
      if (next === undefined) return { ok: false, problem: { code: 'not_found' } };
      return { ok: true, resource: viewOf(next) };
    });
  }
  /**
   * A state transition (FRW-030): one conditional `UPDATE` on the state and revision the caller
   * read. It sets the new state, `sent_seq` and `sent_hash` when given, the participants as the
   * transition leaves them, and raises the revision. Nothing else changes in the row.
   */
  transition(
    tenant: string,
    doc: string,
    from: { readonly state: string; readonly rev: number },
    write: WorkflowTransitionWrite,
  ): Promise<WorkflowTransitionResult> {
    const at = new Date(this.#now()).toISOString();
    return inTenant(this.#pool, tenant, async (c): Promise<WorkflowTransitionResult> => {
      const row = await lockRow(c, tenant, doc);
      if (row === null) return { ok: false, problem: { code: 'not_found' } };
      if (row.state !== from.state || row.rev !== from.rev)
        return { ok: false, problem: { code: 'conflict', state: row.state, rev: row.rev } };
      const updated = await c.query<Row>(
        `UPDATE ${WORKFLOW_RESOURCE_TABLE}
            SET state = $3,
                sent_seq = COALESCE($4::bigint, sent_seq),
                sent_hash = COALESCE($5, sent_hash),
                participants = COALESCE($6::jsonb, participants),
                rev = rev + 1, updated_at = $7
          WHERE tenant_id = $1 AND doc_id = $2
          RETURNING ${COLUMNS}`,
        [
          tenant,
          doc,
          write.to,
          write.sentSeq ?? null,
          write.sentHash ?? null,
          write.participants === undefined ? null : JSON.stringify(write.participants),
          at,
        ],
      );
      const next = updated.rows[0];
      if (next === undefined) return { ok: false, problem: { code: 'not_found' } };
      return { ok: true, resource: viewOf(next) };
    });
  }

  /**
   * The write behind `PUT /documents/{id}/workflow` (FRW-025): `expectedRev` 0 creates the workflow,
   * any other value replaces the writable members of a `draft` one at that revision. The input has
   * passed `checkWorkflowBody`.
   */
  put(
    tenant: string,
    doc: string,
    expectedRev: number,
    input: WorkflowInput,
  ): Promise<WorkflowPutResult> {
    const at = new Date(this.#now()).toISOString();
    const participants = JSON.stringify(input.participants);
    const members = JSON.stringify(input.members);
    return inTenant(this.#pool, tenant, async (c): Promise<WorkflowPutResult> => {
      const row = await lockRow(c, tenant, doc);
      if (row === null) {
        if (expectedRev !== 0)
          return { ok: false, problem: { code: 'precondition_failed', rev: 0 } };
        const inserted = await c.query<Row>(
          `INSERT INTO ${WORKFLOW_RESOURCE_TABLE}
             (tenant_id, doc_id, id, state, rev, time_zone, participants, members, created_at, updated_at)
           VALUES ($1, $2, $3, 'draft', 1, $4, $5::jsonb, $6::jsonb, $7, $7)
           ON CONFLICT (tenant_id, doc_id) DO NOTHING
           RETURNING ${COLUMNS}`,
          [tenant, doc, uuid7(), input.timeZone, participants, members, at],
        );
        const made = inserted.rows[0];
        // A concurrent creation won: the caller read revision 0, which is now stale.
        if (made === undefined)
          return { ok: false, problem: { code: 'precondition_failed', rev: 1 } };
        return { ok: true, resource: viewOf(made), created: true };
      }
      if (row.state !== 'draft')
        return { ok: false, problem: { code: 'workflow_active', state: row.state } };
      if (expectedRev !== row.rev)
        return { ok: false, problem: { code: 'precondition_failed', rev: row.rev } };
      const updated = await c.query<Row>(
        `UPDATE ${WORKFLOW_RESOURCE_TABLE}
            SET time_zone = $3, participants = $4::jsonb, members = $5::jsonb,
                rev = rev + 1, updated_at = $6
          WHERE tenant_id = $1 AND doc_id = $2
          RETURNING ${COLUMNS}`,
        [tenant, doc, input.timeZone, participants, members, at],
      );
      const next = updated.rows[0];
      if (next === undefined)
        return { ok: false, problem: { code: 'precondition_failed', rev: row.rev } };
      return { ok: true, resource: viewOf(next), created: false };
    });
  }
}
