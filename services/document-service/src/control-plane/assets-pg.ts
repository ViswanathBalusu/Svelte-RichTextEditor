/**
 * The `assets` rows in PostgreSQL (migration 0042; 06 §4.1), under the tenant's row-level security.
 * The port, its record types and the in-memory registry are in `assets.ts`; this adapter is in a
 * file of its own so that the handlers, which import that module, load no database client
 * (BE-002 criterion 1).
 */
import { inTenant, int, isUuid, millis, type Pool } from '../storage/db.ts';
import type {
  AssetReadyFacts,
  AssetRecord,
  AssetRegistry,
  AssetState,
  NewAsset,
} from './assets.ts';

interface Row {
  id: string;
  tenant_id: string;
  doc_id: string;
  filename: string | null;
  mime: string;
  declared_bytes: string;
  state: AssetState;
  sha256: Buffer | null;
  bytes: string | null;
  content_type: string | null;
  object_key: string | null;
  width: number | null;
  height: number | null;
  frames: number | null;
  renditions: unknown[];
  failure: { code: string; reason: string } | null;
  job_id: string | null;
  created_by: string;
  created_at: Date;
  upload_expires_at: Date;
  completed_at: Date | null;
  settled_at: Date | null;
}

function toRecord(r: Row): AssetRecord {
  return {
    id: r.id,
    tenant: r.tenant_id,
    doc: r.doc_id,
    filename: r.filename,
    mime: r.mime,
    declaredBytes: int(r.declared_bytes),
    state: r.state,
    sha256: r.sha256 ? r.sha256.toString('hex') : null,
    bytes: r.bytes === null ? null : int(r.bytes),
    contentType: r.content_type,
    objectKey: r.object_key,
    width: r.width,
    height: r.height,
    frames: r.frames,
    renditions: r.renditions ?? [],
    failure: r.failure,
    jobId: r.job_id,
    createdBy: r.created_by,
    createdAt: millis(r.created_at)!,
    uploadExpiresAt: millis(r.upload_expires_at)!,
    completedAt: millis(r.completed_at),
    settledAt: millis(r.settled_at),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The rows in PostgreSQL (migration 0042), under the tenant's row-level security. */
export class PgAssetRegistry implements AssetRegistry {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  create(tenant: string, a: NewAsset, now: number): Promise<AssetRecord> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query<Row>(
        `INSERT INTO assets (id, tenant_id, doc_id, filename, mime, declared_bytes, state,
                             created_by, created_at, upload_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'quarantined', $7, $8, $9) RETURNING *`,
        [
          a.id,
          tenant,
          a.doc,
          a.filename,
          a.mime,
          a.declaredBytes,
          a.createdBy,
          iso(now),
          iso(a.uploadExpiresAt),
        ],
      );
      return toRecord(r.rows[0]!);
    });
  }

  get(tenant: string, id: string): Promise<AssetRecord | null> {
    // A bare identifier that is not a UUID names no asset; the column is uuid, so PostgreSQL would fail (500).
    if (!isUuid(id)) return Promise.resolve(null);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>('SELECT * FROM assets WHERE id = $1', [id]);
        return r.rows[0] ? toRecord(r.rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  many(tenant: string, ids: readonly string[]): Promise<AssetRecord[]> {
    // Identifiers that are not UUIDs name no asset (see get); they are dropped before the uuid[] cast.
    const uuids = [...new Set(ids)].filter((id) => isUuid(id));
    if (uuids.length === 0) return Promise.resolve([]);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>('SELECT * FROM assets WHERE id = ANY ($1::uuid[])', [uuids]);
        return r.rows.map(toRecord);
      },
      { readOnly: true },
    );
  }

  storedBytes(tenant: string): Promise<number> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ n: string }>(
          `SELECT COALESCE(SUM(CASE WHEN state = 'failed' THEN 0
                                    WHEN state = 'ready' THEN COALESCE(bytes, declared_bytes)
                                    ELSE declared_bytes END), 0)::text AS n
             FROM assets WHERE tenant_id = $1`,
          [tenant],
        );
        return Number(r.rows[0]?.n ?? '0');
      },
      { readOnly: true },
    );
  }

  readyFor(tenant: string, doc: string): Promise<AssetRecord[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          "SELECT * FROM assets WHERE doc_id = $1 AND state = 'ready' ORDER BY created_at",
          [doc],
        );
        return r.rows.map(toRecord);
      },
      { readOnly: true },
    );
  }

  markProcessing(tenant: string, id: string, job: string, now: number) {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query<Row>(
        `UPDATE assets SET state = 'processing', job_id = $2, completed_at = $3
          WHERE id = $1 AND state = 'quarantined' RETURNING *`,
        [id, job, iso(now)],
      );
      return r.rows[0] ? toRecord(r.rows[0]) : null;
    });
  }

  settleReady(tenant: string, id: string, f: AssetReadyFacts, now: number) {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        `UPDATE assets SET state = 'ready', sha256 = $2, bytes = $3, content_type = $4,
                           object_key = $5, width = $6, height = $7, frames = $8,
                           renditions = $9::jsonb, failure = NULL, settled_at = $10
          WHERE id = $1 AND state IN ('processing', 'quarantined')`,
        [
          id,
          Buffer.from(f.sha256, 'hex'),
          f.bytes,
          f.contentType,
          f.objectKey,
          f.width,
          f.height,
          f.frames,
          JSON.stringify(f.renditions),
          iso(now),
        ],
      );
      return r.rowCount === 1;
    });
  }

  settleFailed(tenant: string, id: string, failure: { code: string; reason: string }, now: number) {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        `UPDATE assets SET state = 'failed', failure = $2::jsonb, settled_at = $3
          WHERE id = $1 AND state IN ('processing', 'quarantined')`,
        [id, JSON.stringify(failure), iso(now)],
      );
      return r.rowCount === 1;
    });
  }

  expiredUploads(tenant: string, before: number, limit: number): Promise<AssetRecord[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT * FROM assets WHERE state = 'quarantined' AND upload_expires_at < $1
            ORDER BY upload_expires_at LIMIT $2`,
          [iso(before), limit],
        );
        return r.rows.map(toRecord);
      },
      { readOnly: true },
    );
  }

  remove(tenant: string, id: string): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      // Only an upload nobody completed is removed (BE-046): a row that a worker has taken stays.
      const r = await c.query("DELETE FROM assets WHERE id = $1 AND state = 'quarantined'", [id]);
      return r.rowCount === 1;
    });
  }

  orphanedReady(tenant: string, before: number, limit: number): Promise<AssetRecord[]> {
    // A ready asset with no attachment row (BE-046 criterion 1), oldest settlement first.
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT a.* FROM assets a
            WHERE a.state = 'ready' AND a.settled_at < $1
              AND NOT EXISTS (SELECT 1 FROM doc_assets d WHERE d.asset_id = a.id)
            ORDER BY a.settled_at LIMIT $2`,
          [iso(before), limit],
        );
        return r.rows.map(toRecord);
      },
      { readOnly: true },
    );
  }

  removeOrphan(
    tenant: string,
    id: string,
  ): Promise<{ removed: boolean; objectKey: string | null }> {
    return inTenant(this.#pool, tenant, async (c) => {
      // Only a ready asset that no attachment names is removed: the row is deleted with its
      // attachments absent, and a foreign key would refuse it otherwise (migration 0064).
      const r = await c.query<{ object_key: string | null }>(
        `DELETE FROM assets a WHERE a.id = $1 AND a.state = 'ready'
            AND NOT EXISTS (SELECT 1 FROM doc_assets d WHERE d.asset_id = a.id)
         RETURNING a.object_key`,
        [id],
      );
      const row = r.rows[0];
      if (!row) return { removed: false, objectKey: null };
      if (row.object_key === null) return { removed: true, objectKey: null };
      // The object is shared by every asset of the same content: delete it only when none is left.
      const left = await c.query('SELECT 1 FROM assets WHERE object_key = $1 LIMIT 1', [
        row.object_key,
      ]);
      return { removed: true, objectKey: left.rowCount === 0 ? row.object_key : null };
    });
  }
}
