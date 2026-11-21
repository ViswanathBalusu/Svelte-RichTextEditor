/**
 * The asset worker of `services/asset-worker` (BE-042 to BE-045) as the control plane uses it
 * (PRO-061, PRO-062; ADR 0054): its check of a declared upload, its size-bound pre-signed upload
 * into quarantine, its signed URLs of the separate asset origin, and its job handler, whose outcome
 * becomes the state of the `assets` row and the `asset.ready` or `asset.failed` notification.
 *
 * Without S3 settings, uploads go to the in-memory object store (development and tests: a test
 * writes the quarantined bytes itself). Without an asset origin and its URL key, URLs are the
 * object store's own short-lived signed URLs.
 */
import {
  ASSET_JOB_KIND,
  AssetJobError,
  assetUrlExpiry,
  checkDeclaredUpload,
  createAssetWorker,
  ObjectTooLarge,
  presignQuarantineUpload,
  S3AssetObjects,
  signAssetUrl,
  type AssetObjects,
  type AssetOutcome,
  type AssetUrlKeys,
  type Sandbox,
} from '@docedit/asset-worker';
import { settleAsset, type AssetRegistry, type AssetUploads } from '../control-plane/assets.ts';
import type { NotifyFn } from '../control-plane/exports.ts';
import { JobFailure, type JobHandler } from '../control-plane/jobs/runner.ts';
import type { AssetStore } from '../storage/types.ts';
import type { S3Settings } from './s3.ts';
import { ObjectExistsError, type ObjectStore } from './store.ts';

// `settleAsset` is the control plane's (`control-plane/assets.ts`): the handlers settle a row
// without loading this module, which joins the worker's functions and its S3 client to the service.
export { ASSET_JOB_KIND, settleAsset };

export interface AssetPipelineOptions {
  /** The store the service uses; quarantine and final objects live in it. */
  objects: ObjectStore;
  assets: AssetStore;
  s3: S3Settings | null;
  /** The separate origin that serves assets (10 §3.5), for example `https://assets.example.com`. */
  origin: string | null;
  /** The keys the asset origin checks URLs with; required with `origin`. */
  urlKeys: AssetUrlKeys | null;
  /** Lifetime of upload URLs, seconds (a setting). */
  uploadSeconds: number;
  /** Lifetime of asset URLs, ms (a setting; 10 §3.7 "short-lived"). */
  urlLifetimeMs: number;
}

/** The control plane's `AssetUploads` over the asset worker's functions. */
export function assetUploads(o: AssetPipelineOptions): AssetUploads {
  const s3 = o.s3 ? new S3AssetObjects(o.s3) : null;
  if (o.origin && !o.urlKeys) throw new Error('an asset origin needs its URL key');
  return {
    check(req) {
      const r = checkDeclaredUpload(req);
      return r.ok
        ? { ok: true, mime: r.mime, maxBytes: r.maxBytes }
        : { ok: false, code: r.code, message: r.message };
    },
    presign({ tenant, asset, size, lifetimeSeconds }) {
      if (s3) {
        const u = presignQuarantineUpload(s3, { tenant, asset, size, lifetimeSeconds });
        return { url: u.url, method: 'PUT', headers: { ...u.headers }, expiresAt: u.expiresAt };
      }
      // In memory there is no upload endpoint; the bytes go in through the store (tests).
      return {
        url: `memory://quarantine/${tenant}/${asset}`,
        method: 'PUT',
        headers: { 'content-length': String(size) },
        expiresAt: Date.now() + lifetimeSeconds * 1000,
      };
    },
    sign({ tenant, sha256, contentType, objectKey, now }) {
      if (o.origin && o.urlKeys) {
        const expiresAt = assetUrlExpiry(
          now,
          o.urlLifetimeMs,
          Math.min(60_000, o.urlLifetimeMs / 2),
        );
        return {
          url: signAssetUrl({
            origin: o.origin,
            tenant,
            sha256,
            mime: contentType,
            expiresAt,
            keys: o.urlKeys,
          }),
          expiresAt,
        };
      }
      const expiresAt = now + o.urlLifetimeMs;
      return { url: o.assets.signedUrl(tenant, objectKey, expiresAt), expiresAt };
    },
  };
}

/** The service's object store as the asset worker reads and writes it. */
export function workerObjects(store: ObjectStore): AssetObjects {
  return {
    async get(key, maxBytes) {
      const b = await store.get(key);
      if (b && b.length > maxBytes)
        throw new ObjectTooLarge(`${key} is larger than ${maxBytes} bytes`);
      return b;
    },
    async put(key, body, opts) {
      try {
        await store.put(key, body, {
          contentType: opts.contentType,
          ...(opts.ifAbsent ? { ifAbsent: true } : {}),
        });
        return 'written';
      } catch (e) {
        if (e instanceof ObjectExistsError) return 'exists';
        throw e;
      }
    },
    async head(key) {
      const b = await store.get(key);
      return b ? { bytes: b.length } : null;
    },
    delete: (key) => store.delete(key),
  };
}

/**
 * The job handler of kind `asset` for a worker in this process: the asset worker's `handle`, its
 * outcome settled on the row, its retryable errors turned into job retries.
 */
export function assetJobHandler(opts: {
  objects: AssetObjects;
  sandbox: Sandbox;
  allowUnsandboxed?: boolean;
  registry: AssetRegistry;
  notify?: () => NotifyFn | undefined;
  now: () => number;
  /** Called with each ready asset, for the meters of stored bytes (BE-085). */
  stored?: (tenant: string, bytes: number) => void;
}): JobHandler {
  const worker = createAssetWorker({
    objects: opts.objects,
    sandbox: opts.sandbox,
    ...(opts.allowUnsandboxed ? { allowUnsandboxed: true } : {}),
  });
  return async (job, ctx) => {
    let outcome: AssetOutcome;
    try {
      outcome = await worker.handle(
        { tenant: job.tenant, id: job.id, payload: job.payload },
        {
          signal: ctx.signal,
          report: (stage, progress) => ctx.report(stage, progress),
        },
      );
    } catch (e) {
      if (e instanceof AssetJobError) throw new JobFailure(e.code, e.message, e.retry);
      throw e;
    }
    await settleAsset(opts.registry, outcome, opts.now(), opts.notify?.());
    // A file that failed its checks ends the job failed, without another attempt (ADR 0043).
    if (!outcome.ok)
      throw new JobFailure(outcome.code, outcome.message, false, { ...outcome } as Record<
        string,
        unknown
      >);
    opts.stored?.(outcome.tenant, outcome.bytes);
    return { ...outcome } as unknown as Record<string, unknown>;
  };
}
