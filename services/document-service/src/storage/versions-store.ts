/**
 * Stored versions in PostgreSQL (HIS-006 criterion 1; 08 §4; 06 §4.1 `versions`; migration 0050).
 * A version is a pointer to a `seq` with a kind. This store writes the row a named version needs:
 * the `seq` (the head when none is given), the kind, the name and note as text, the creator's
 * surrogate and the server time. The kinds are the seven of 08 §4; `packages/history` holds the
 * rules for which `seq` may be named and is not imported here, because this package does not
 * depend on it. The caller passes the lowest `seq` the requester may see (the gate's `min`).
 *
 * Creating a version for a document, `seq` and kind that is already stored returns the stored
 * version and writes nothing (HIS-007 criterion 5). The row is locked with the document's head, so
 * a version is never named for a `seq` above a head that a commit is still advancing.
 *
 * Not in this store: the requester's `edit` check (`createVersion` in `@docedit/history`, which the
 * service calls first), the events and webhooks of HIS-006 criterion 4, and the HTTP route.
 */
import { inTenant, type Pool } from './db.ts';
import type { DocRef } from './types.ts';

/** The seven version kinds of 08 §4, as the `versions.kind` check constraint has them. */
export const STORED_VERSION_KINDS = [
  'named',
  'export',
  'pre-restore',
  'restore',
  'import',
  'sent',
  'completed',
] as const;

export type StoredVersionKind = (typeof STORED_VERSION_KINDS)[number];

export interface VersionInput {
  /** The sequence number to name; when omitted, the head of the document at the time. */
  seq?: number;
  kind: string;
  name?: string;
  note?: string;
  /** The creator's surrogate identifier (never the host's `sub`; HIS-003). */
  createdBy: string;
  /** Server time, Unix milliseconds. */
  createdAt: number;
}

export interface StoredVersionRow {
  seq: number;
  kind: StoredVersionKind;
  name?: string;
  note?: string;
  createdBy: string;
  createdAt: number;
}

export type VersionRefusal = 'validation_failed' | 'forbidden' | 'not_found';

export type VersionOutcome =
  | { ok: true; version: StoredVersionRow; created: boolean }
  | { ok: false; code: VersionRefusal; message: string };

interface VersionDbRow {
  seq: string;
  kind: StoredVersionKind;
  name: string | null;
  note: string | null;
  created_by: string;
  created_at: Date;
}

function toRow(r: VersionDbRow): StoredVersionRow {
  const v: StoredVersionRow = {
    seq: Number(r.seq),
    kind: r.kind,
    createdBy: r.created_by,
    createdAt: r.created_at.getTime(),
  };
  if (r.name !== null) v.name = r.name;
  if (r.note !== null) v.note = r.note;
  return v;
}

/** Versions in PostgreSQL, under the tenant's row-level security (BE-011). */
export class PgVersionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Stores a version pointing at `input.seq` (or the head), or returns the stored one with the same
   * `seq` and kind. `minSeq` is the requester's visibility gate: a `seq` below it is `forbidden`.
   */
  create(
    ref: DocRef,
    input: VersionInput,
    options: { minSeq?: number } = {},
  ): Promise<VersionOutcome> {
    return inTenant(this.#pool, ref.tenant, async (c): Promise<VersionOutcome> => {
      // The head is read under a row lock, so the check and the insert see the same head.
      const h = await c.query<{ head_seq: string }>(
        'select head_seq from doc_heads where doc_id = $1 for update',
        [ref.doc],
      );
      if (h.rows.length === 0)
        return { ok: false, code: 'not_found', message: `no document ${ref.doc}` };
      const head = Number(h.rows[0]!.head_seq);
      if (!(STORED_VERSION_KINDS as readonly string[]).includes(input.kind))
        return {
          ok: false,
          code: 'validation_failed',
          message: `kind ${input.kind} is not a version kind`,
        };
      const seq = input.seq ?? head;
      if (!Number.isSafeInteger(seq) || seq < 0)
        return {
          ok: false,
          code: 'validation_failed',
          message: `seq ${seq} is not a sequence number`,
        };
      if (seq > head)
        return {
          ok: false,
          code: 'validation_failed',
          message: `seq ${seq} is above the head ${head}`,
        };
      const min = options.minSeq ?? 0;
      if (seq < min)
        return {
          ok: false,
          code: 'forbidden',
          message: `seq ${seq} is below your visibility gate`,
        };
      const ins = await c.query(
        `insert into versions (doc_id, tenant_id, seq, kind, name, note, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (doc_id, seq, kind) do nothing`,
        [
          ref.doc,
          ref.tenant,
          seq,
          input.kind,
          input.name ?? null,
          input.note ?? null,
          input.createdBy,
          new Date(input.createdAt),
        ],
      );
      const r = await c.query<VersionDbRow>(
        `select seq, kind, name, note, created_by, created_at from versions
          where doc_id = $1 and seq = $2 and kind = $3`,
        [ref.doc, seq, input.kind],
      );
      return { ok: true, version: toRow(r.rows[0]!), created: ins.rowCount === 1 };
    });
  }

  /**
   * The stored versions of a document, oldest `seq` first, then by kind. Automatic versions are not
   * stored. `minSeq` leaves out versions below the requester's gate; `kind` keeps one kind only
   * (an export lists its `export` versions, a restore its `pre-restore` and `restore`; HIS-007).
   */
  list(
    ref: DocRef,
    options: { minSeq?: number; kind?: StoredVersionKind } = {},
  ): Promise<StoredVersionRow[]> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<VersionDbRow>(
          `select seq, kind, name, note, created_by, created_at from versions
            where doc_id = $1 and seq >= $2 and ($3::text is null or kind = $3)
            order by seq, kind`,
          [ref.doc, options.minSeq ?? 0, options.kind ?? null],
        );
        return r.rows.map(toRow);
      },
      { readOnly: true },
    );
  }
}
