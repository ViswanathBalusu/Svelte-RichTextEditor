/**
 * Assets on the control plane (05 §6.2; 06 §4.4; 10 §3.5; PRO-061, PRO-062; decision D142; ADR
 * 0054). The asset worker (`services/asset-worker`, BE-042 to BE-045) checks, re-encodes and stores
 * uploads; this module keeps the `assets` rows (migration 0042), answers the three routes and turns
 * the worker's outcome into the row's state and the `asset.ready` and `asset.failed` notifications.
 *
 * - `POST /documents/{id}/assets` needs `edit`, `suggest` or `fill` somewhere in the document (row
 *   6 of 07 §12). The declared type and size are checked first; the answer is the asset's
 *   identifier and a pre-signed upload of exactly the declared size into the quarantine key.
 * - `POST /assets/{aid}/complete` is resolved to the asset's document, which the caller's token
 *   must cover (05 §6.1); the uploader or a service credential completes it, which queues the
 *   worker's job (kind `asset`) and answers 202.
 * - `POST /documents/{id}/assets/resolve` needs `view` (row 7). It signs a short-lived URL for each
 *   requested asset that is ready and attached to the document as the caller may read it: used in
 *   the caller's projection of the content at the head (SR-C4), or uploaded for the document by the
 *   caller. Preserved fragments of an imported file are resolved only for readers who see the whole
 *   document (SR-C1). Anything else gets no URL.
 */
import type { JsonNode } from '@docedit/model';
import { CDM1 } from '@docedit/model/definition';
import { inTenant, int, isUuid, millis, type Pool } from '../storage/db.ts';
import { ApiError } from './problems.ts';

export type AssetState = 'quarantined' | 'processing' | 'ready' | 'failed';

export interface AssetRecord {
  id: string;
  tenant: string;
  /** The document the asset was uploaded for. */
  doc: string;
  filename: string | null;
  /** The declared type, as the client sent it. */
  mime: string;
  declaredBytes: number;
  state: AssetState;
  /** Set by the worker: the SHA-256 it computed, lower-case hex. */
  sha256: string | null;
  bytes: number | null;
  contentType: string | null;
  objectKey: string | null;
  width: number | null;
  height: number | null;
  frames: number | null;
  renditions: unknown[];
  failure: { code: string; reason: string } | null;
  jobId: string | null;
  /** The uploader's surrogate (BE-013). */
  createdBy: string;
  createdAt: number;
  uploadExpiresAt: number;
  completedAt: number | null;
  settledAt: number | null;
}

export interface NewAsset {
  id: string;
  doc: string;
  filename: string | null;
  mime: string;
  declaredBytes: number;
  createdBy: string;
  uploadExpiresAt: number;
}

export interface AssetReadyFacts {
  sha256: string;
  bytes: number;
  contentType: string;
  objectKey: string;
  width: number | null;
  height: number | null;
  frames: number | null;
  renditions: unknown[];
}

/** The `assets` rows (06 §4.1). */
export interface AssetRegistry {
  create(tenant: string, a: NewAsset, now: number): Promise<AssetRecord>;
  get(tenant: string, id: string): Promise<AssetRecord | null>;
  many(tenant: string, ids: readonly string[]): Promise<AssetRecord[]>;
  /** The ready assets uploaded for a document (06 §4.4: what its content may reference). */
  readyFor(tenant: string, doc: string): Promise<AssetRecord[]>;
  /** From `quarantined` to `processing` with the job; null when the asset is in another state. */
  markProcessing(tenant: string, id: string, job: string, now: number): Promise<AssetRecord | null>;
  /** From `processing` (or `quarantined`) to `ready`; false when the asset had settled already. */
  settleReady(tenant: string, id: string, facts: AssetReadyFacts, now: number): Promise<boolean>;
  settleFailed(
    tenant: string,
    id: string,
    failure: { code: string; reason: string },
    now: number,
  ): Promise<boolean>;
  /** Quarantined uploads whose upload window ended before `before`, for the scheduler (BE-052). */
  expiredUploads(tenant: string, before: number, limit: number): Promise<AssetRecord[]>;
  remove(tenant: string, id: string): Promise<boolean>;
  /**
   * The bytes a tenant's assets hold against its storage quota (BE-092): the stored size of a ready
   * asset, the declared size of one still being uploaded or processed, and nothing for a failed one.
   */
  storedBytes(tenant: string): Promise<number>;
  /**
   * Ready assets settled before `before` that no `doc_assets` row attaches (BE-046 criterion 1).
   * The in-memory registry keeps no attachments and so reports none (it never removes a ready asset).
   */
  orphanedReady(tenant: string, before: number, limit: number): Promise<AssetRecord[]>;
  /**
   * Removes a ready asset that no attachment names. `objectKey` is the object to delete afterwards:
   * it is set only when no other row names that object, since ready objects are shared by hash.
   */
  removeOrphan(tenant: string, id: string): Promise<{ removed: boolean; objectKey: string | null }>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAssetRegistry implements AssetRegistry {
  readonly #rows = new Map<string, AssetRecord>();

  #find(tenant: string, id: string): AssetRecord | undefined {
    const r = this.#rows.get(id);
    return r && r.tenant === tenant ? r : undefined;
  }

  async create(tenant: string, a: NewAsset, now: number): Promise<AssetRecord> {
    if (this.#rows.has(a.id)) throw new Error(`asset ${a.id} exists`);
    const r: AssetRecord = {
      id: a.id,
      tenant,
      doc: a.doc,
      filename: a.filename,
      mime: a.mime,
      declaredBytes: a.declaredBytes,
      state: 'quarantined',
      sha256: null,
      bytes: null,
      contentType: null,
      objectKey: null,
      width: null,
      height: null,
      frames: null,
      renditions: [],
      failure: null,
      jobId: null,
      createdBy: a.createdBy,
      createdAt: now,
      uploadExpiresAt: a.uploadExpiresAt,
      completedAt: null,
      settledAt: null,
    };
    this.#rows.set(a.id, r);
    return clone(r);
  }

  async get(tenant: string, id: string): Promise<AssetRecord | null> {
    const r = this.#find(tenant, id);
    return r ? clone(r) : null;
  }

  async many(tenant: string, ids: readonly string[]): Promise<AssetRecord[]> {
    return ids.flatMap((id) => {
      const r = this.#find(tenant, id);
      return r ? [clone(r)] : [];
    });
  }

  async readyFor(tenant: string, doc: string): Promise<AssetRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.tenant === tenant && r.doc === doc && r.state === 'ready')
      .map(clone);
  }

  async markProcessing(tenant: string, id: string, job: string, now: number) {
    const r = this.#find(tenant, id);
    if (!r || r.state !== 'quarantined') return null;
    Object.assign(r, { state: 'processing', jobId: job, completedAt: now });
    return clone(r);
  }

  async settleReady(tenant: string, id: string, f: AssetReadyFacts, now: number) {
    const r = this.#find(tenant, id);
    if (!r || (r.state !== 'processing' && r.state !== 'quarantined')) return false;
    Object.assign(r, { state: 'ready', ...clone(f), failure: null, settledAt: now });
    return true;
  }

  async settleFailed(
    tenant: string,
    id: string,
    failure: { code: string; reason: string },
    now: number,
  ) {
    const r = this.#find(tenant, id);
    if (!r || (r.state !== 'processing' && r.state !== 'quarantined')) return false;
    Object.assign(r, { state: 'failed', failure: { ...failure }, settledAt: now });
    return true;
  }

  async expiredUploads(tenant: string, before: number, limit: number): Promise<AssetRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.tenant === tenant && r.state === 'quarantined' && r.uploadExpiresAt < before)
      .slice(0, limit)
      .map(clone);
  }

  async storedBytes(tenant: string): Promise<number> {
    let n = 0;
    for (const r of this.#rows.values()) {
      if (r.tenant !== tenant || r.state === 'failed') continue;
      n += r.state === 'ready' ? (r.bytes ?? r.declaredBytes) : r.declaredBytes;
    }
    return n;
  }

  async remove(tenant: string, id: string): Promise<boolean> {
    // Only an upload nobody completed is removed (BE-046), as in PgAssetRegistry.remove.
    const r = this.#find(tenant, id);
    return r?.state === 'quarantined' ? this.#rows.delete(id) : false;
  }

  async orphanedReady(_tenant: string, _before: number, _limit: number): Promise<AssetRecord[]> {
    // No attachments are kept in memory, so no ready asset can be shown to be unattached here.
    return [];
  }

  async removeOrphan(
    _tenant: string,
    _id: string,
  ): Promise<{ removed: boolean; objectKey: string | null }> {
    return { removed: false, objectKey: null };
  }
}

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

// ---------------------------------------------------------------------------------------------

/** What the control plane needs of the asset pipeline (the asset worker's package, or a stand-in). */
export interface AssetUploads {
  /** Checks a declared upload before anything is created (BE-042). */
  check(req: {
    filename?: unknown;
    mime?: unknown;
    size?: unknown;
  }):
    | { ok: true; mime: string; maxBytes: number }
    | { ok: false; code: 'too_large' | 'validation_failed'; message: string };
  /** A pre-signed upload of exactly `size` bytes into `tenants/{tenant}/quarantine/{asset}`. */
  presign(args: { tenant: string; asset: string; size: number; lifetimeSeconds: number }): {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: number;
  };
  /**
   * A short-lived URL of a stored object, served with a fixed content type, from the separate asset
   * origin when there is one (10 §3.5, §3.7); `expiresAt` in Unix ms.
   */
  sign(args: {
    tenant: string;
    sha256: string;
    contentType: string;
    objectKey: string;
    now: number;
  }): { url: string; expiresAt: number };
}

/** Attributes whose value is an asset identifier, by node type, from the CDM definition (I4). */
const ASSET_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const n of CDM1.nodes)
    for (const [name, a] of Object.entries(n.attrs))
      if (a.grammar.kind === 'ref' && a.grammar.to === 'asset') {
        let s = out.get(n.name);
        if (!s) out.set(n.name, (s = new Set()));
        s.add(name);
      }
  return out;
})();

/** The attribute of the preservation layer (ADR 0017) that holds an original fragment. */
const FRAGMENT_ATTRIBUTES = new Set(['fragment']);

/**
 * The asset identifiers a document's content references, split into display assets and preserved
 * fragments (SR-C1): only readers who see the whole document get the latter.
 */
export function assetReferences(doc: JsonNode): { display: Set<string>; fragments: Set<string> } {
  const display = new Set<string>();
  const fragments = new Set<string>();
  const stack: unknown[] = [doc];
  while (stack.length) {
    const n = stack.pop() as {
      type?: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    };
    if (!n || typeof n !== 'object') continue;
    const names = n.type ? ASSET_ATTRIBUTES.get(n.type) : undefined;
    if (names && n.attrs)
      for (const name of names) {
        const v = n.attrs[name];
        if (typeof v === 'string') (FRAGMENT_ATTRIBUTES.has(name) ? fragments : display).add(v);
      }
    if (Array.isArray(n.content)) stack.push(...n.content);
  }
  return { display, fragments };
}

/** The most identifiers one resolve request may carry (D142; a setting of the route). */
export const MAX_RESOLVE = 200;

export function checkResolveRequest(assets: readonly string[]): void {
  if (assets.length > MAX_RESOLVE)
    throw new ApiError('validation_failed', `at most ${MAX_RESOLVE} assets per request`, {
      violations: [{ path: '/assets', rule: `at most ${MAX_RESOLVE} identifiers (D142)` }],
    });
}
