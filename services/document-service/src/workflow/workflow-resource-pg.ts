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
 * Not built here: the HTTP route and its status codes, the `GET` of the other members of the resource
 * (`routing`, `deadline`, `reminders`, `consent`, `finalisation`, FRW-025 criterion 1), the
 * published JSON Schema, and the state changes of the actions (`send` and the rest). The caller's
 * `manage` is passed in, as the route will read it from the token.
 */
import { uuid7 } from '@docedit/model';
import {
  checkParticipants,
  type ParticipantDraft,
  type ParticipantProblem,
} from '@docedit/authority';
import { inTenant, type Pool, type Queryable } from '../storage/db.ts';

export const WORKFLOW_RESOURCE_TABLE = 'workflow_resource';

/** The caller's right: `manage` is the right of 07 §4 that owns the workflow. */
export interface ResourceCaller {
  readonly manage: boolean;
}

/** The resource as a read returns it. `etag` is the revision as a quoted string (strong ETag). */
export interface WorkflowResourceView {
  readonly id: string;
  readonly doc: string;
  readonly state: string;
  readonly rev: number;
  readonly etag: string;
  readonly timeZone: string;
  readonly participants: readonly ParticipantDraft[];
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

const etagOf = (rev: number): string => `"${rev}"`;

interface Row {
  id: string;
  doc_id: string;
  state: string;
  rev: number;
  time_zone: string;
  participants: unknown;
}

function viewOf(row: Row): WorkflowResourceView {
  const checked = checkParticipants(row.participants);
  const participants = checked.ok ? checked.participants : [];
  return {
    id: row.id,
    doc: row.doc_id,
    state: row.state,
    rev: row.rev,
    etag: etagOf(row.rev),
    timeZone: row.time_zone,
    participants,
  };
}

async function lockRow(c: Queryable, tenant: string, doc: string): Promise<Row | null> {
  const r = await c.query<Row>(
    `SELECT id, doc_id, state, rev, time_zone, participants
       FROM ${WORKFLOW_RESOURCE_TABLE}
      WHERE tenant_id = $1 AND doc_id = $2
      FOR UPDATE`,
    [tenant, doc],
  );
  return r.rows[0] ?? null;
}

export class PgWorkflowResourceStore {
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
         RETURNING id, doc_id, state, rev, time_zone, participants`,
        [tenant, doc, id, options.timeZone, at],
      ),
    );
    const row = inserted.rows[0];
    if (row === undefined) return { ok: false, problem: { code: 'exists' } };
    return { ok: true, resource: viewOf(row) };
  }

  /** The resource of a document with its ETag, or null when the document has no workflow. */
  read(tenant: string, doc: string): Promise<WorkflowResourceView | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT id, doc_id, state, rev, time_zone, participants
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
          RETURNING id, doc_id, state, rev, time_zone, participants`,
        [tenant, doc, JSON.stringify(checked.participants), at],
      );
      const next = updated.rows[0];
      if (next === undefined) return { ok: false, problem: { code: 'not_found' } };
      return { ok: true, resource: viewOf(next) };
    });
  }
}
