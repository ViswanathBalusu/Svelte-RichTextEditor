/**
 * The asset routes (05 §6.2; PRO-061, PRO-062; D142). See assets.ts for the rules.
 */
import { formatTimestamp, uuid7 } from '@docedit/model';
import type { CreateAssetRequest } from '@docedit/protocol';
import { ASSET_JOB_KIND } from '@docedit/asset-worker';
import type { AssetOutcome } from '@docedit/asset-worker';
import { settleAsset } from '../objects/asset-pipeline.ts';
import {
  assetReferences,
  checkResolveRequest,
  type AssetRecord,
  type AssetRegistry,
} from './assets.ts';
import { connectionOn, regionInfosOfJson, requireRow } from './gate.ts';
import { json, type Kit } from './kit.ts';
import { admitStorage } from './live-quota-rest.ts';
import { guard, hiddenFrom, type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { projectContent, readerView } from './visibility.ts';

export function assetRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument } = k;

  function registry(): AssetRegistry {
    if (!d.assetRegistry || !d.uploads)
      throw new ApiError('not_found', 'this server does not take assets');
    return d.assetRegistry;
  }

  /** The upload's state as the routes show it. */
  const assetBody = (a: AssetRecord) => ({
    asset: a.id,
    doc: a.doc,
    state: a.state,
    ...(a.state === 'failed' && a.failure
      ? { error: { code: a.failure.code, reason: a.failure.reason } }
      : {}),
  });

  /**
   * A row found `processing` whose job finished in a worker of another process: its outcome is the
   * job's result (the asset worker returns it), settled now.
   */
  async function settled(a: AssetRecord): Promise<AssetRecord> {
    if (a.state !== 'processing' || !a.jobId) return a;
    const job = await d.queue.get(a.tenant, a.jobId);
    if (!job || (job.state !== 'completed' && job.state !== 'failed')) return a;
    const outcome = job.result as unknown as AssetOutcome | null;
    if (outcome && typeof outcome.ok === 'boolean' && outcome.asset === a.id)
      await settleAsset(registry(), { ...outcome, tenant: a.tenant }, d.now(), k.notify());
    else if (job.state === 'failed')
      // A worker that failed the job without an outcome: the job's error is the reason.
      await settleAsset(
        registry(),
        {
          ok: false,
          tenant: a.tenant,
          asset: a.id,
          code: job.error?.code === 'too_large' ? 'too_large' : 'validation_failed',
          reason: 'bad_reply',
          message: 'the asset job failed',
        },
        d.now(),
        k.notify(),
      );
    return (await registry().get(a.tenant, a.id)) ?? a;
  }

  const createAsset: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    const reg = registry();
    await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    // Row 6 of 07 §12: `edit`, `suggest` or `fill` somewhere in the document, grants included.
    if (ctx.caller.kind === 'user') {
      const head = await d.logs.head(ref);
      const full = await d.content.rebuild(ref, head.incarnation, head.seq);
      requireRow(
        ctx.caller,
        'asset.upload',
        doc,
        regionInfosOfJson(full.doc),
        await d.grants.current(ref),
        d.now(),
      );
    }
    const body = (await ctx.body()) as CreateAssetRequest;
    // The declared type and size first: nothing is created for a refused upload (BE-042).
    const check = d.uploads!.check({ filename: body.filename, mime: body.mime, size: body.size });
    if (!check.ok)
      throw new ApiError(check.code, check.message, {
        ...(check.code === 'validation_failed'
          ? { violations: [{ path: '/mime', rule: 'a type and size the asset worker accepts' }] }
          : {}),
      });
    // BE-092 criterion 1: an upload that would take the tenant past its storage quota is refused.
    await admitStorage(d.quotaSource, ctx.caller.tenant, body.size, (t) => reg.storedBytes(t));
    const now = d.now();
    const lifetime = d.uploadSeconds ?? 900;
    const id = uuid7(now);
    const upload = d.uploads!.presign({
      tenant: ctx.caller.tenant,
      asset: id,
      size: body.size,
      lifetimeSeconds: lifetime,
    });
    const row = await reg.create(
      ctx.caller.tenant,
      {
        id,
        doc,
        filename: body.filename,
        mime: check.mime,
        declaredBytes: body.size,
        createdBy: ctx.caller.actor,
        uploadExpiresAt: upload.expiresAt,
      },
      now,
    );
    return json(
      201,
      {
        ...assetBody(row),
        upload: {
          url: upload.url,
          method: upload.method,
          headers: upload.headers,
          expiresAt: formatTimestamp(upload.expiresAt),
        },
      },
      { 'Cache-Control': 'no-store' },
    );
  };

  /** The asset of a bare identifier, resolved to its document (05 §6.1). */
  async function assetOf(ctx: Ctx): Promise<AssetRecord> {
    const a = await registry().get(ctx.caller.tenant, ctx.params['aid']!);
    if (!a) throw new ApiError('not_found', `no asset ${ctx.params['aid']}`);
    // The caller's token must cover the asset's document; if it does not, the asset is not found
    // (owner decision 57; SEC-016 criterion 4).
    if (hiddenFrom(ctx.caller, a.doc))
      throw new ApiError('not_found', `no asset ${ctx.params['aid']}`);
    connectionOn(ctx.caller, a.doc);
    await liveDocument(ctx, a.doc);
    return a;
  }

  const completeAsset: Handler = async (ctx) => {
    const a = await assetOf(ctx);
    // The uploader or a service credential completes an upload (D142).
    if (ctx.caller.kind === 'user' && a.createdBy !== ctx.caller.actor)
      throw new ApiError('forbidden', 'an upload is completed by its uploader');
    if (a.state !== 'quarantined') return json(202, assetBody(await settled(a)));
    const job = await d.queue.enqueue(ctx.caller.tenant, {
      kind: ASSET_JOB_KIND,
      doc: a.doc,
      createdBy: a.createdBy,
      // What the asset worker reads, and nothing else (ADR 0043).
      payload: { asset: a.id, mime: a.mime, size: a.declaredBytes },
    });
    const marked = await registry().markProcessing(ctx.caller.tenant, a.id, job.id, d.now());
    d.onJobQueued?.();
    return json(202, assetBody(marked ?? a));
  };

  const resolveAssets: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // Row 7 of 07 §12: `view` on a document the asset is attached to.
    guard(ctx.caller, 'asset.read', doc);
    const reg = registry();
    await liveDocument(ctx, doc);
    const body = (await ctx.body()) as { assets: string[] };
    checkResolveRequest(body.assets);
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const perms = await d.grants.current(ref);
    const view = readerView(d.views, connectionOn(ctx.caller, doc), full.doc, perms);
    // Attached as the caller may read it: referenced in their projection at the head (SR-C4);
    // preserved fragments of an imported file only for the whole document (SR-C1).
    const refs = assetReferences(projectContent(view, full.doc));
    const visible = new Set(refs.display);
    if (view.full) for (const f of refs.fragments) visible.add(f);
    // BE-045 criterion 1: only an asset attached to this document is resolved, that is one with a
    // `doc_assets` row, or one uploaded for this document (BE-044). An identifier of another
    // document's asset that content names is not resolved, whatever the content says.
    const attached = (await d.logs.attachedAssets?.(ref)) ?? new Map<string, number>();
    const now = d.now();
    const out: Array<{ asset: string; url: string; expiresAt: string; contentType: string }> = [];
    for (const row of await reg.many(ctx.caller.tenant, [...new Set(body.assets)])) {
      const a = await settled(row);
      const mine = a.doc === doc && a.createdBy === ctx.caller.actor;
      if (a.state !== 'ready' || !a.sha256 || !a.objectKey || !a.contentType) continue;
      if (a.doc !== doc && !attached.has(a.id)) continue;
      if (!visible.has(a.id) && !mine) continue;
      const signed = d.uploads!.sign({
        tenant: a.tenant,
        sha256: a.sha256,
        contentType: a.contentType,
        objectKey: a.objectKey,
        now,
      });
      out.push({
        asset: a.id,
        url: signed.url,
        expiresAt: formatTimestamp(signed.expiresAt),
        contentType: a.contentType,
      });
    }
    return json(200, { assets: out }, { 'Cache-Control': 'no-store' });
  };

  return { createAsset, completeAsset, resolveAssets };
}
