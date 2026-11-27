/**
 * Document metadata in PostgreSQL (06 §4.1 `documents`, `doc_heads`; BE-009, BE-035). Creating a
 * document writes its row, its head row (head 0, epoch 0, a new incarnation), its first grants
 * revision and that revision's permission state, in one transaction. The content at sequence
 * number 0 is a checkpoint in object storage (CheckpointStore; decision D67), written by the
 * control plane before the row, so that a document never exists without its content.
 *
 * Metadata changes are conditional on the metadata revision (the resource's ETag). A change of
 * state is a change of permission data: it raises the grants revision first, as PgGrantStore does,
 * so that a log write checked against the old state is refused (04 G7; 07 §9), and the locks are
 * taken in the same order as there (grant_revisions, then documents).
 */
import type { DocumentState, PermissionState } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { insertAuditEvent } from '../data-plane/pg/audit.ts';
import {
  assertUuid,
  constraintOf,
  inTenant,
  int,
  millis,
  sqlState,
  SQLSTATE,
  type Pool,
  type Queryable,
} from './db.ts';
import {
  applyPermissionRows,
  readPermissions,
  recordRevision,
  translateGrantError,
} from './grant-store.ts';
import {
  DocumentNotFoundError,
  DuplicateExternalIdError,
  RevisionConflictError,
  type DocRef,
  type DocumentChangeOptions,
  type DocumentPatch,
  type DocumentQuery,
  type DocumentRecord,
  type DocumentStore,
  type NewDocument,
} from './types.ts';

interface DocumentRow {
  id: string;
  tenant_id: string;
  external_id: string | null;
  title: string | null;
  properties: Record<string, unknown>;
  label: string | null;
  state: DocumentState;
  cdm_version: number;
  requires: string[];
  history_visibility: string;
  created_by: string;
  created_at: Date;
  deleted_at: Date | null;
  meta_rev: string;
  forked_from: string | null;
  forked_at_seq: string | null;
  incarnation: string;
  head_seq: string;
}

function toRecord(r: DocumentRow): DocumentRecord {
  return {
    id: r.id,
    tenant: r.tenant_id,
    externalId: r.external_id,
    title: r.title,
    state: r.state,
    cdmVersion: r.cdm_version,
    requires: r.requires,
    historyVisibility: r.history_visibility,
    createdBy: r.created_by,
    createdAt: millis(r.created_at)!,
    incarnation: r.incarnation,
    head: int(r.head_seq),
    properties: r.properties,
    label: r.label,
    deletedAt: millis(r.deleted_at),
    metaRevision: int(r.meta_rev),
    forkedFrom: r.forked_from,
    forkedAtSeq: r.forked_at_seq === null ? null : int(r.forked_at_seq),
  };
}

const COLUMNS = `
  d.id, d.tenant_id, d.external_id, d.title, d.properties, d.label, d.state, d.cdm_version,
  d.requires, d.history_visibility, d.created_by, d.created_at, d.deleted_at, d.meta_rev,
  d.forked_from, d.forked_at_seq, h.incarnation, h.head_seq`;

const SELECT_DOCUMENT = `
  SELECT ${COLUMNS}
    FROM documents d JOIN doc_heads h ON h.doc_id = d.id
   WHERE d.id = $1`;

async function readRecord(c: Queryable, doc: string): Promise<DocumentRecord | null> {
  const r = await c.query<DocumentRow>(SELECT_DOCUMENT, [doc]);
  const row = r.rows[0];
  return row ? toRecord(row) : null;
}

export class PgDocumentStore implements DocumentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(tenant: string, input: NewDocument): Promise<DocumentRecord> {
    const id = input.id ?? uuid7();
    assertUuid(id, 'document');
    const ref: DocRef = { tenant, doc: id };
    const perms = input.permissions;
    const revision = perms?.revision ?? 1;
    try {
      return await inTenant(this.#pool, tenant, async (c) => {
        await c.query(
          `INSERT INTO documents (id, tenant_id, external_id, title, properties, label, state,
                                  cdm_version, requires, created_by, created_at,
                                  forked_from, forked_at_seq)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, now(), $11, $12)`,
          [
            id,
            tenant,
            input.externalId ?? null,
            input.title ?? null,
            JSON.stringify(input.properties ?? {}),
            input.label ?? null,
            perms?.documentState ?? 'active',
            input.cdmVersion,
            [...(input.requires ?? [])],
            input.createdBy,
            input.fork?.from ?? null,
            input.fork?.atSeq ?? null,
          ],
        );
        await c.query(
          'INSERT INTO doc_heads (doc_id, tenant_id, incarnation) VALUES ($1, $2, gen_random_uuid())',
          [id, tenant],
        );
        await c.query(
          'INSERT INTO grant_revisions (doc_id, tenant_id, rev, workflow_active) VALUES ($1, $2, $3, $4)',
          [id, tenant, revision, perms?.workflowActive ?? false],
        );
        if (perms)
          await applyPermissionRows(
            c,
            ref,
            {
              putGrants: perms.grants,
              setRegionStates: [...perms.regionStates].map(([region, state]) => ({
                region,
                state,
              })),
              putLeases: perms.leases,
            },
            input.createdBy,
          );
        const state: PermissionState = await readPermissions(c, id);
        await recordRevision(c, ref, state, input.createdBy);
        return (await readRecord(c, id))!;
      });
    } catch (e) {
      if (
        sqlState(e) === SQLSTATE.uniqueViolation &&
        constraintOf(e) === 'documents_tenant_id_external_id_key'
      )
        throw new DuplicateExternalIdError('another document of the tenant has this externalId');
      throw translateGrantError(e);
    }
  }

  get(ref: DocRef): Promise<DocumentRecord | null> {
    assertUuid(ref.doc, 'document');
    return inTenant(this.#pool, ref.tenant, (c) => readRecord(c, ref.doc), { readOnly: true });
  }

  list(tenant: string, query: DocumentQuery): Promise<DocumentRecord[]> {
    if (query.after !== undefined) assertUuid(query.after, 'cursor');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1)
      throw new RangeError('limit must be a positive integer');
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<DocumentRow>(
          `SELECT ${COLUMNS}
             FROM documents d JOIN doc_heads h ON h.doc_id = d.id
            WHERE d.deleted_at IS NULL
              AND ($1::text IS NULL OR d.external_id = $1)
              AND ($2::uuid IS NULL OR d.id > $2)
            ORDER BY d.id
            LIMIT $3`,
          [query.externalId ?? null, query.after ?? null, query.limit],
        );
        return r.rows.map(toRecord);
      },
      { readOnly: true },
    );
  }

  async update(
    ref: DocRef,
    patch: DocumentPatch,
    opts: DocumentChangeOptions,
  ): Promise<{ record: DocumentRecord; perms: PermissionState | null }> {
    assertUuid(ref.doc, 'document');
    try {
      return await inTenant(this.#pool, ref.tenant, async (c) => {
        // The state is permission data: the revision row first, in PgGrantStore's lock order.
        let stateChange = false;
        if (patch.state !== undefined) {
          const cur = await c.query<{ state: DocumentState; deleted: boolean }>(
            `SELECT d.state, d.deleted_at IS NOT NULL AS deleted
               FROM grant_revisions g JOIN documents d ON d.id = g.doc_id
              WHERE g.doc_id = $1 FOR UPDATE OF g`,
            [ref.doc],
          );
          const row = cur.rows[0];
          if (!row || row.deleted) throw new DocumentNotFoundError(`no document ${ref.doc}`);
          stateChange = row.state !== patch.state;
          if (stateChange)
            await c.query('UPDATE grant_revisions SET rev = rev + 1 WHERE doc_id = $1', [ref.doc]);
        }
        const r = await c.query<{ meta_rev: string }>(
          `UPDATE documents
              SET title = CASE WHEN $2 THEN $3 ELSE title END,
                  properties = CASE WHEN $4 THEN $5::jsonb ELSE properties END,
                  label = CASE WHEN $6 THEN $7 ELSE label END,
                  meta_rev = meta_rev + 1
            WHERE id = $1 AND deleted_at IS NULL AND ($8::bigint IS NULL OR meta_rev = $8)
            RETURNING meta_rev`,
          [
            ref.doc,
            patch.title !== undefined,
            patch.title ?? null,
            patch.properties !== undefined,
            JSON.stringify(patch.properties ?? {}),
            patch.label !== undefined,
            patch.label ?? null,
            opts.ifMetaRevision ?? null,
          ],
        );
        if (r.rowCount !== 1) throw await this.#refusal(c, ref.doc, opts.ifMetaRevision);
        let perms: PermissionState | null = null;
        if (stateChange) {
          await applyPermissionRows(c, ref, { documentState: patch.state! }, opts.actor);
          perms = await readPermissions(c, ref.doc);
          await recordRevision(c, ref, perms, opts.actor);
          // The state is permission data: audited with the change, like a grant (PRM-051; BE-014).
          await insertAuditEvent(c, {
            id: uuid7(),
            tenant: ref.tenant,
            doc: ref.doc,
            actor: opts.actor,
            kind: 'grants.changed',
            data: { rev: perms.revision, scopes: ['doc'], documentState: patch.state! },
            at: Date.now(),
          });
        }
        return { record: (await readRecord(c, ref.doc))!, perms };
      });
    } catch (e) {
      throw translateGrantError(e);
    }
  }

  remove(ref: DocRef, opts: DocumentChangeOptions): Promise<DocumentRecord> {
    assertUuid(ref.doc, 'document');
    return inTenant(this.#pool, ref.tenant, async (c) => {
      const r = await c.query(
        `UPDATE documents SET deleted_at = now(), meta_rev = meta_rev + 1
          WHERE id = $1 AND deleted_at IS NULL AND ($2::bigint IS NULL OR meta_rev = $2)`,
        [ref.doc, opts.ifMetaRevision ?? null],
      );
      if (r.rowCount !== 1) throw await this.#refusal(c, ref.doc, opts.ifMetaRevision);
      return (await readRecord(c, ref.doc))!;
    });
  }

  setCdmVersion(ref: DocRef, from: number, to: number): Promise<boolean> {
    assertUuid(ref.doc, 'document');
    return inTenant(this.#pool, ref.tenant, async (c) => {
      const r = await c.query(
        `UPDATE documents SET cdm_version = $3
          WHERE id = $1 AND deleted_at IS NULL AND cdm_version = $2`,
        [ref.doc, from, to],
      );
      if (r.rowCount === 1) return true;
      const cur = await c.query<{ deleted: boolean }>(
        'SELECT deleted_at IS NOT NULL AS deleted FROM documents WHERE id = $1',
        [ref.doc],
      );
      const row = cur.rows[0];
      if (!row || row.deleted) throw new DocumentNotFoundError(`no document ${ref.doc}`);
      return false;
    });
  }

  /** Why a conditional update changed no row: no document, or a stale revision. */
  async #refusal(c: Queryable, doc: string, ifRev: number | undefined): Promise<Error> {
    const cur = await c.query<{ meta_rev: string; deleted: boolean }>(
      'SELECT meta_rev, deleted_at IS NOT NULL AS deleted FROM documents WHERE id = $1',
      [doc],
    );
    const row = cur.rows[0];
    if (!row || row.deleted) return new DocumentNotFoundError(`no document ${doc}`);
    return new RevisionConflictError(
      `the metadata revision is ${row.meta_rev}, not ${String(ifRev)}`,
      int(row.meta_rev),
    );
  }
}
