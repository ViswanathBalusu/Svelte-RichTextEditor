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
 *
 * This module holds the port of the rows and the in-memory registry, and loads no database client
 * and no part of the asset worker (BE-002 criterion 1); the registry over PostgreSQL is
 * `assets-pg.ts`, and the worker's functions are joined to the service in
 * `objects/asset-pipeline.ts`.
 */
import type { AssetOutcome } from '@docedit/asset-worker';
import type { JsonNode } from '@docedit/model';
import { CDM1 } from '@docedit/model/definition';
import type { Notification } from '@docedit/protocol';
import type { DocRef } from '../storage/types.ts';
import { ApiError } from './problems.ts';

export type AssetState = 'quarantined' | 'processing' | 'ready' | 'failed';

/**
 * How a settlement is announced on the uploader's channels (05 §5.6): the data plane's `notify`
 * (the `NotifyFn` of `exports.ts` fits it). Declared here, so that this module does not depend on
 * the export hooks, which depend on the job runner and the data plane's seams.
 */
export type AssetNotify = (
  ref: DocRef,
  notification: Notification,
  opts?: { user?: string },
) => void;

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
  /**
   * Attaches a ready asset to its document from commit `seq` on, as a `doc_assets` row, though no
   * content names it: the original Word file of an import (EXP-108 criterion 3). An attached asset
   * is never selected as an orphan. The in-memory registry keeps no attachments and does nothing.
   */
  attach(tenant: string, doc: string, id: string, seq: number): Promise<void>;
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

  async attach(_tenant: string, _doc: string, _id: string, _seq: number): Promise<void> {
    // No attachments are kept in memory (see orphanedReady).
  }
}

/**
 * Writes an outcome of the asset worker to the `assets` row and tells the uploader's channels
 * (05 §5.6 `asset.ready`, `asset.failed`). Used by the in-process handler and when a row is found
 * `processing` whose job finished in another process.
 */
export async function settleAsset(
  registry: AssetRegistry,
  outcome: AssetOutcome,
  now: number,
  notify?: AssetNotify,
): Promise<boolean> {
  const before = await registry.get(outcome.tenant, outcome.asset);
  if (!before) return false;
  const changed = outcome.ok
    ? await registry.settleReady(
        outcome.tenant,
        outcome.asset,
        {
          sha256: outcome.sha256,
          bytes: outcome.bytes,
          contentType: outcome.contentType,
          objectKey: outcome.objectKey,
          width: outcome.width,
          height: outcome.height,
          frames: outcome.frames,
          renditions: outcome.renditions,
        },
        now,
      )
    : await registry.settleFailed(
        outcome.tenant,
        outcome.asset,
        { code: outcome.code, reason: outcome.reason },
        now,
      );
  if (changed)
    notify?.(
      { tenant: before.tenant, doc: before.doc },
      {
        type: outcome.ok ? 'asset.ready' : 'asset.failed',
        resource: `/assets/${before.id}`,
        data: outcome.ok ? { state: 'ready' } : { state: 'failed', code: outcome.code },
      },
      { user: before.createdBy },
    );
  return changed;
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
