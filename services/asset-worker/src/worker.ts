/**
 * The asset worker's job (06 §4.4; BE-043; SEC-037 criteria 1 and 2; SEC-038; SEC-040). For one
 * completed upload it reads the quarantined object (bounded by the declared size), runs the content
 * checks in the sandbox, reads the reply as hostile, computes the SHA-256 of each output itself,
 * writes `tenants/{tenant}/assets/{sha256}` once with a fixed content type, deletes the quarantined
 * object, and reports the outcome. A declared hash is never read: the job payload has no place for
 * one. The tenant comes from the job's row, never from its payload (BE-049 criterion 5).
 *
 * Content failures (a hostile, broken or unsupported file, or a sandbox stopped at a limit) end the
 * asset as failed and are not retried; failures of the object store or of the container engine
 * throw `AssetJobError` with `retry`, leaving the quarantined object for the next attempt.
 */
import { createHash } from 'node:crypto';
import { assetKeys, isUuid } from './keys.ts';
import { ObjectStoreUnavailable, ObjectTooLarge, type AssetObjects } from './objects.ts';
import type { Sandbox } from './sandbox-port.ts';
import { registryCode, type FailureReason } from './sandbox/errors.ts';
import { encodeFrame, REQUEST_MAGIC } from './sandbox/frame.ts';
import { contentLimits, type ContentLimits } from './sandbox/limits.ts';
import { checkDeclared } from './sandbox/process.ts';
import { DOCX, normaliseMime, type AcceptedType, type OutputType } from './sandbox/types.ts';
import { readReply } from './verify.ts';

/** The job kind the control plane enqueues on `POST /assets/{aid}/complete`. */
export const ASSET_JOB_KIND = 'asset';

/** What the control plane puts in the job's payload. Nothing else is read from it. */
export interface AssetJobPayload {
  /** The asset's identifier (the `assets` row). */
  asset: string;
  /** The MIME type the client declared. */
  mime: string;
  /** The size the client declared and the upload was bound to. */
  size: number;
}

/** A claimed job as the worker needs it: the tenant of the job's row, its identifier, its payload. */
export interface AssetJob {
  tenant: string;
  id: string;
  payload: unknown;
}

export interface AssetRendition {
  role: 'print';
  mime: OutputType;
  sha256: string;
  bytes: number;
  objectKey: string;
}

/** Everything the control plane writes to the `assets` row and sends with `asset.ready`. */
export interface AssetReady {
  ok: true;
  tenant: string;
  asset: string;
  /** The checked type (equal to the declared one, normalised). */
  mime: AcceptedType;
  /** The type the stored object is served with. */
  contentType: string;
  sha256: string;
  bytes: number;
  objectKey: string;
  width: number | null;
  height: number | null;
  frames: number | null;
  /** Further objects for the typesetter: a PNG of a GIF's first frame, a PDF of an SVG. */
  renditions: AssetRendition[];
  /** What was removed or changed (identifiers only). */
  notes: string[];
}

/** Everything the control plane writes to the `assets` row and sends with `asset.failed`. */
export interface AssetFailed {
  ok: false;
  tenant: string;
  asset: string;
  /** The registry code of 05 §5.8. */
  code: 'too_large' | 'validation_failed';
  reason: FailureReason;
  /** Rules and numbers only, never content. */
  message: string;
}

export type AssetOutcome = AssetReady | AssetFailed;

/** Called once per job after the objects are written or the quarantined upload is deleted. */
export interface AssetOutcomes {
  /** Set the row `ready` with `sha256`, `bytes`, `object_key`; raise `asset.ready`. */
  ready(r: AssetReady): Promise<void>;
  /** Set the row `failed`; raise `asset.failed`. */
  failed(f: AssetFailed): Promise<void>;
}

/** The job could not be done for a reason outside the file; `retry` says whether to try again. */
export class AssetJobError extends Error {
  override name = 'AssetJobError';
  readonly code: 'unavailable' | 'internal';
  readonly retry: boolean;
  constructor(code: 'unavailable' | 'internal', message: string, retry: boolean) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
}

export interface AssetWorkerOptions {
  objects: AssetObjects;
  sandbox: Sandbox;
  limits?: Partial<ContentLimits>;
  outcomes?: AssetOutcomes;
  /** Run with `unsandboxed()`: tests and development only. */
  allowUnsandboxed?: boolean;
  /** Stored with each final object. */
  cacheControl?: string;
}

export interface JobContext {
  signal?: AbortSignal;
  report?: (stage: string, progress?: number) => Promise<unknown>;
}

export interface AssetWorker {
  readonly limits: ContentLimits;
  handle(job: AssetJob, ctx?: JobContext): Promise<AssetOutcome>;
}

function parsePayload(p: unknown): AssetJobPayload {
  if (typeof p !== 'object' || p === null)
    throw new AssetJobError('internal', 'the job payload is not an object', false);
  const r = p as Record<string, unknown>;
  if (!isUuid(r['asset']))
    throw new AssetJobError('internal', 'the job payload has no asset identifier', false);
  if (typeof r['mime'] !== 'string' || r['mime'].length > 255)
    throw new AssetJobError('internal', 'the job payload has no type', false);
  if (typeof r['size'] !== 'number' || !Number.isSafeInteger(r['size']))
    throw new AssetJobError('internal', 'the job payload has no size', false);
  return { asset: r['asset'], mime: r['mime'], size: r['size'] };
}

const sha256hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function createAssetWorker(opts: AssetWorkerOptions): AssetWorker {
  if (opts.sandbox.kind !== 'podman' && !opts.allowUnsandboxed)
    throw new Error(
      'the asset worker refuses to run without its sandbox (allowUnsandboxed is for tests)',
    );
  const limits = contentLimits(opts.limits);
  const objects = opts.objects;
  const cacheControl = opts.cacheControl ?? 'private, max-age=31536000, immutable';

  const storeError = (e: unknown): never => {
    if (e instanceof AssetJobError) throw e;
    if (e instanceof ObjectStoreUnavailable)
      throw new AssetJobError('unavailable', e.message, true);
    throw new AssetJobError(
      'unavailable',
      `object storage failed (${e instanceof Error ? e.name : 'error'})`,
      true,
    );
  };

  async function handle(job: AssetJob, ctx: JobContext = {}): Promise<AssetOutcome> {
    if (!isUuid(job.tenant)) throw new AssetJobError('internal', 'the job has no tenant', false);
    const tenant = job.tenant;
    const p = parsePayload(job.payload);
    const qkey = assetKeys.quarantine(tenant, p.asset);

    const fail = async (reason: FailureReason, message: string): Promise<AssetFailed> => {
      try {
        await objects.delete(qkey);
      } catch (e) {
        storeError(e);
      }
      const f: AssetFailed = {
        ok: false,
        tenant,
        asset: p.asset,
        code: registryCode(reason),
        reason,
        message,
      };
      await opts.outcomes?.failed(f);
      return f;
    };

    const declaredBad = checkDeclared(p.mime, p.size, limits);
    if (declaredBad) return fail(declaredBad.reason, declaredBad.message);
    const declared = normaliseMime(p.mime) as AcceptedType;
    await ctx.report?.('checking', 10);

    let bytes: Uint8Array | null;
    try {
      const head = await objects.head(qkey);
      if (!head) return fail('missing_upload', 'nothing was uploaded for this asset');
      if (head.bytes !== p.size)
        return fail(
          'size_mismatch',
          `the upload has ${head.bytes} bytes, not the ${p.size} declared`,
        );
      bytes = await objects.get(qkey, p.size);
    } catch (e) {
      if (e instanceof ObjectTooLarge)
        return fail('size_mismatch', `the upload is larger than the ${p.size} bytes declared`);
      return storeError(e);
    }
    if (!bytes) return fail('missing_upload', 'nothing was uploaded for this asset');
    if (bytes.length !== p.size)
      return fail(
        'size_mismatch',
        `the upload has ${bytes.length} bytes, not the ${p.size} declared`,
      );

    const request = encodeFrame(REQUEST_MAGIC, { v: 1, declared, limits }, [bytes]);
    const run = await opts.sandbox.run(request, ctx.signal ? { signal: ctx.signal } : {});
    if (run.aborted) throw new AssetJobError('internal', 'the job was stopped', false);
    if (run.engineError)
      throw new AssetJobError(
        'unavailable',
        `the sandbox could not run (${run.engineError.slice(0, 120)})`,
        true,
      );
    if (run.timedOut) return fail('resource_limit', 'the sandbox was stopped at its time limit');
    if (run.outputOverflow)
      return fail('output_limit', 'the sandbox wrote more than its output limit');
    if (run.exitCode !== 0) {
      // 137: killed (the memory limit, or the time limit inside Podman); 134: the heap limit.
      const limit = run.exitCode === null || run.exitCode === 137 || run.exitCode === 134;
      return fail(
        limit ? 'resource_limit' : 'decode_failed',
        limit
          ? 'the sandbox was stopped at its memory or time limit'
          : `the sandbox stopped with exit code ${run.exitCode}`,
      );
    }
    const reply = readReply(run.stdout, declared, limits);
    if (!reply.ok) return fail(reply.reason, reply.message);

    await ctx.report?.('storing', 80);
    // A Word file is kept as uploaded (EXP-108); anything else is replaced by its new display file.
    const display = reply.outputs.find((o) => o.role === 'display');
    const primaryMime: string = reply.keepOriginal ? DOCX : display!.mime;
    const primaryData = reply.keepOriginal ? bytes : display!.data;
    const renditions: AssetRendition[] = [];
    let sha256: string;
    try {
      sha256 = sha256hex(primaryData);
      await objects.put(assetKeys.final(tenant, sha256), primaryData, {
        contentType: primaryMime,
        cacheControl,
        ifAbsent: true,
      });
      for (const o of reply.outputs) {
        if (o.role !== 'print') continue;
        const sha = sha256hex(o.data);
        const key = assetKeys.final(tenant, sha);
        await objects.put(key, o.data, { contentType: o.mime, cacheControl, ifAbsent: true });
        renditions.push({
          role: 'print',
          mime: o.mime,
          sha256: sha,
          bytes: o.data.length,
          objectKey: key,
        });
      }
      await objects.delete(qkey);
    } catch (e) {
      return storeError(e);
    }
    const ready: AssetReady = {
      ok: true,
      tenant,
      asset: p.asset,
      mime: declared,
      contentType: primaryMime,
      sha256,
      bytes: primaryData.length,
      objectKey: assetKeys.final(tenant, sha256),
      width: reply.width,
      height: reply.height,
      frames: reply.frames,
      renditions,
      notes: reply.notes,
    };
    await opts.outcomes?.ready(ready);
    await ctx.report?.('done', 100);
    return ready;
  }

  return { limits, handle };
}
