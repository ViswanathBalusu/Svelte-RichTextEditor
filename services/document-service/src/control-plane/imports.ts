/**
 * Word import jobs (05 §6.2; 07 §11, §12; 09 §12; EXP-098). `POST /documents/{id}/imports` queues a
 * job for an uploaded `.docx` asset; the job reads the asset, runs the importer, checks the result
 * as `PUT /documents/{id}/content` does, and stores it as a snapshot commit with origin `import`
 * (the data plane resets the open channels with reason `import`). A completed job adds a version of
 * kind `import` and raises `import.completed` and `dep.import.completed`; a failed one raises
 * `import.failed` and `dep.import.failed`.
 *
 * The importer is a port (`DocxImporter`): this package does not depend on `@docedit/export-docx`,
 * and the sandboxed worker of EXP-099 criterion 1 is not built. A node that is given no importer
 * does not offer the routes. See docs/adr/0373-w2-EXP-098-import-job.md.
 */
import {
  canonicalize,
  formatTimestamp,
  uuid7,
  type JsonEnvelope,
  type JsonNode,
} from '@docedit/model';
import { readDocument } from '@docedit/model/validate';
import type { CreateImportRequest, ImportJob } from '@docedit/protocol';
import type { AssetStore, DocRef, GrantStore } from '../storage/types.ts';
import type { DataPlane } from '../seams.ts';
import type { VersionStorePort } from '../storage/versions-memory.ts';
import { assetReferences, type AssetRecord, type AssetRegistry } from './assets.ts';
import { objectKeys } from '../objects/store.ts';
import { regionNodeOf } from './content.ts';
import type { ContentReader } from './content.ts';
import type { EventSink } from './events.ts';
import type { NotifyFn } from './exports.ts';
import { JobFailure, type JobHandler, type JobHooks } from './jobs/runner.ts';
import type { JobRecord } from './jobs/queue.ts';
import type { DocxImporter, ImportedDocument, PictureProcessor } from './import-port.ts';
import { json, type HandlerDeps, type Kit } from './kit.ts';
import { capabilitiesOn, hiddenFrom, type Ctx, type Handler } from './pipeline.ts';
import { ApiError, type RestCode } from './problems.ts';

export const IMPORT_KIND = 'import';

/**
 * The start of the note of the `import` version, which names the original file by the identifier of
 * its asset (EXP-108 criterion 4): the identifier follows after a space. The wording is a choice of
 * this lane, proposed, not specified; the `versions` table has no column for an asset.
 */
export const ORIGINAL_NOTE = 'Original Word file: asset';

/** The content type of a Word file, as the asset worker records it. */
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type { DocxImporter, ImportedDocument } from './import-port.ts';

export interface ImportJobDeps {
  importer: DocxImporter;
  /** Passes the pictures of an import through the asset worker (EXP-101 criterion 3). */
  pictures?: PictureProcessor | undefined;
  assets: Pick<AssetStore, 'getFinal' | 'putFinal'>;
  registry: AssetRegistry;
  grants: Pick<GrantStore, 'current' | 'retired'>;
  content: Pick<ContentReader, 'read'>;
  dataPlane: Pick<DataPlane, 'replaceContent'>;
  /** The clock for the asset records; the default is the system clock. */
  now?: () => number;
}

/**
 * Stores the assets an import's content names and registers each as a ready asset of the document,
 * under the identifier the content uses (I4, EXP-116 criterion 5). An identifier that is already
 * registered is left alone, so a retried job does not fail. Returns the identifiers it created, for
 * the caller to remove when the commit fails.
 */
async function registerImportedAssets(
  o: {
    registry: AssetRegistry;
    assets: Pick<AssetStore, 'putFinal'>;
    /** The asset worker for pictures (EXP-101 criterion 3); without it the bytes are kept as they are. */
    pictures?: PictureProcessor | undefined;
  },
  ref: DocRef,
  imported: ImportedDocument,
  actor: string,
  now: number,
): Promise<string[]> {
  const created: string[] = [];
  try {
    for (const a of imported.assets ?? []) {
      if (await o.registry.get(ref.tenant, a.id)) continue;
      await o.registry.create(
        ref.tenant,
        {
          id: a.id,
          doc: ref.doc,
          filename: a.filename ?? null,
          mime: a.contentType,
          declaredBytes: a.bytes.length,
          createdBy: actor,
          uploadExpiresAt: now,
        },
        now,
      );
      created.push(a.id);
      // A picture goes through the asset worker, which decodes it and stores the re-encoded file
      // under its own hash (EXP-101 criterion 3). A type the worker does not accept is kept as it
      // was brought, as before; a picture the worker refuses fails the import.
      const picture = o.pictures
        ? await o.pictures(ref.tenant, a.id, a.bytes, a.contentType)
        : null;
      if (picture && !picture.ok)
        throw new JobFailure(
          'validation_failed',
          `a picture of the Word file was refused: ${picture.message}`,
        );
      if (picture?.ok) {
        const settledPicture = await o.registry.settleReady(
          ref.tenant,
          a.id,
          {
            sha256: picture.sha256,
            bytes: picture.bytes,
            contentType: picture.contentType,
            objectKey: picture.objectKey,
            width: picture.width,
            height: picture.height,
            frames: picture.frames,
            renditions: picture.renditions.map((r) => ({ ...r })),
          },
          now,
        );
        if (!settledPicture)
          throw new JobFailure('internal', 'an imported picture could not be stored');
        continue;
      }
      const sha256 = await o.assets.putFinal(ref.tenant, a.bytes, a.contentType);
      const settled = await o.registry.settleReady(
        ref.tenant,
        a.id,
        {
          sha256,
          bytes: a.bytes.length,
          contentType: a.contentType,
          objectKey: objectKeys.asset(ref.tenant, sha256),
          width: null,
          height: null,
          frames: null,
          renditions: [],
        },
        now,
      );
      if (!settled) throw new JobFailure('internal', 'an imported asset could not be stored');
    }
  } catch (e) {
    for (const id of created) await o.registry.remove(ref.tenant, id).catch(() => false);
    throw e;
  }
  return created;
}

const warningsOf = (
  list: ReadonlyArray<string | Record<string, unknown>>,
): Array<Record<string, unknown>> =>
  list.map((w) => (typeof w === 'string' ? { message: w } : { ...w }));

/** A short, content-free text of an error thrown by the importer. */
const reasonOf = (e: unknown): string =>
  (e instanceof Error ? e.message : 'the file could not be read').slice(0, 200);

/**
 * The checks of `PUT /documents/{id}/content` (BE-037) and the snapshot commit with origin `import`,
 * shared by the import job and by `POST /documents` with an import. Returns the commit's `seq`.
 * Every refusal is a `JobFailure`.
 */
export async function storeImported(
  o: Pick<ImportJobDeps, 'registry' | 'grants' | 'content' | 'dataPlane'>,
  ref: DocRef,
  imported: ImportedDocument,
  actor: string,
  requestId: string,
): Promise<number> {
  const { tenant, doc } = ref;
  // The state of the document may have changed since the request, so the checks are made here.
  const perms = await o.grants.current(ref);
  if (perms.workflowActive)
    throw new JobFailure('workflow_active', 'a workflow is active; its content cannot be replaced');
  const current = await o.content.read(ref, { conn: null });
  const attached = new Set(assetReferences(current.doc).display);
  for (const f of assetReferences(current.doc).fragments) attached.add(f);
  for (const a of await o.registry.readyFor(tenant, doc)) attached.add(a.id);
  // This is where I1 to I11 are checked, before the snapshot commit is made (EXP-109 criterion 1).
  const read = readDocument(imported.envelope, {
    attachedAssets: attached,
    retiredRegionIds: new Set(await o.grants.retired(ref)),
  });
  if (!read.ok) {
    const rules =
      read.code === 'validation_failed' && read.violations
        ? [...new Set(read.violations.map((v) => v.invariant))].join(', ')
        : read.code;
    throw new JobFailure(
      read.code,
      `the imported content breaks the model (${rules}); nothing was stored`,
    );
  }
  const envelope = {
    cdm: read.cdm,
    requires: read.requires,
    doc: read.doc.toJSON(),
  } as JsonEnvelope;
  // An approved region must stay as approved (07 §11); an import replaces the whole content.
  for (const [rid, state] of perms.regionStates) {
    if (state !== 'approved') continue;
    const before = regionNodeOf(current.doc, rid);
    const after = regionNodeOf(envelope.doc as JsonNode, rid);
    if (before && (!after || canonicalize(before) !== canonicalize(after)))
      throw new JobFailure(
        'conflict',
        `region ${rid} is approved; change its state first (07 §11)`,
      );
  }
  const replace = o.dataPlane.replaceContent?.bind(o.dataPlane);
  if (!replace) throw new JobFailure('unavailable', 'this server does not replace content');
  let seq: number;
  try {
    // The job is the request: a retry of it after a crash is the same commit (SYN-030 criterion 3).
    ({ seq } = await replace(ref, envelope, actor, { requestId }));
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    throw new JobFailure(typeof code === 'string' ? code : 'internal', reasonOf(e));
  }
  return seq;
}

/** A Word file read for `POST /documents` with an import, before the document exists. */
export interface PreparedImport {
  source: AssetRecord;
  imported: ImportedDocument;
  /** The features the imported content needs, which the new document lists (I1). */
  requires: string[];
}

const REST_CODES: ReadonlySet<string> = new Set<RestCode>([
  'not_found',
  'conflict',
  'validation_failed',
  'workflow_active',
  'unavailable',
]);

/** A refusal of the job's checks as the REST error it is. */
export const asApiError = (e: JobFailure): ApiError =>
  new ApiError(REST_CODES.has(e.code) ? (e.code as RestCode) : 'internal', e.message);

/**
 * `POST /documents` with `import` (EXP-098 criterion 6; owner decision 108). The value is the
 * identifier of a ready `.docx` asset of the tenant. The file is read here, before anything is
 * stored: the importer is a pure function of the bytes, so a file that is refused leaves nothing
 * to remove (docs/adr/0430-w2-EXP-098-new-document-from-import.md).
 */
export async function prepareImport(
  d: Pick<HandlerDeps, 'assetRegistry' | 'assets' | 'importer' | 'importsOffered'>,
  tenant: string,
  assetId: string,
  signal: AbortSignal,
): Promise<PreparedImport> {
  if (!d.importsOffered || !d.importer || !d.assetRegistry)
    throw new ApiError('validation_failed', 'imports are not offered by this server', {
      violations: [{ path: '/import', rule: 'not supported by this server' }],
    });
  const source = await d.assetRegistry.get(tenant, assetId);
  if (!source) throw new ApiError('not_found', `no asset ${assetId}`);
  if (source.state !== 'ready' || source.sha256 === null)
    throw new ApiError('conflict', 'the asset has not been accepted by the asset worker yet');
  if (source.contentType !== DOCX_CONTENT_TYPE)
    throw new ApiError('validation_failed', 'the asset is not a Word file', {
      violations: [{ path: '/import', rule: 'a .docx asset' }],
    });
  const bytes = await d.assets.getFinal(tenant, source.sha256);
  if (!bytes) throw new ApiError('not_found', 'the asset has no stored bytes');
  let imported: ImportedDocument;
  try {
    imported = await d.importer(bytes, { signal });
  } catch (e) {
    throw new ApiError('validation_failed', `the Word file was refused: ${reasonOf(e)}`);
  }
  const read = readDocument(imported.envelope, {
    // The assets the import brings are registered with the document before the content is stored.
    attachedAssets: new Set((imported.assets ?? []).map((a) => a.id)),
    retiredRegionIds: new Set(),
  });
  if (!read.ok)
    throw new ApiError(
      'validation_failed',
      `the imported content breaks the model; nothing was stored`,
    );
  return { source, imported, requires: [...read.requires] };
}

/**
 * The new document exists, empty at seq 0: the source file is attached to it (a record of its own
 * over the same stored bytes, which ready objects share by hash) and then the content is written
 * as the snapshot commit of an import. Returns the commit's `seq` and the attached asset's id.
 * On a failure the caller removes the document; the attached record is removed here.
 */
export async function attachAndStore(
  d: Pick<
    HandlerDeps,
    'assetRegistry' | 'assets' | 'pictures' | 'grants' | 'content' | 'dataPlane' | 'now'
  >,
  ref: DocRef,
  actor: string,
  prepared: PreparedImport,
): Promise<{ seq: number; asset: string }> {
  const registry = d.assetRegistry!;
  const src = prepared.source;
  const id = uuid7();
  const brought = await registerImportedAssets(
    { registry, assets: d.assets, pictures: d.pictures },
    ref,
    prepared.imported,
    actor,
    d.now(),
  );
  await registry.create(
    ref.tenant,
    {
      id,
      doc: ref.doc,
      filename: src.filename,
      mime: src.mime,
      declaredBytes: src.declaredBytes,
      createdBy: actor,
      uploadExpiresAt: d.now(),
    },
    d.now(),
  );
  try {
    const settled = await registry.settleReady(
      ref.tenant,
      id,
      {
        sha256: src.sha256!,
        bytes: src.bytes ?? src.declaredBytes,
        contentType: src.contentType!,
        objectKey: src.objectKey!,
        width: null,
        height: null,
        frames: null,
        renditions: [],
      },
      d.now(),
    );
    if (!settled) throw new JobFailure('internal', 'the source file could not be attached');
    if (!d.dataPlane) throw new JobFailure('unavailable', 'this server does not replace content');
    const seq = await storeImported(
      { registry, grants: d.grants, content: d.content, dataPlane: d.dataPlane },
      ref,
      prepared.imported,
      actor,
      id,
    );
    // The original is attached from the import commit on, so that the retention sweep keeps it and
    // a purge of the document removes it (EXP-108 criterion 3).
    await registry.attach(ref.tenant, ref.doc, id, seq);
    for (const a of brought) await registry.attach(ref.tenant, ref.doc, a, seq);
    return { seq, asset: id };
  } catch (e) {
    await registry.remove(ref.tenant, id).catch(() => false);
    for (const a of brought) await registry.remove(ref.tenant, a).catch(() => false);
    throw e;
  }
}

/**
 * The job handler. Every refusal is a `JobFailure` without retry: an import that failed once would
 * fail again on the same bytes.
 */
export function importJobHandler(o: ImportJobDeps): JobHandler {
  return async (job, ctx) => {
    const doc = String(job.payload['doc']);
    const assetId = String(job.payload['asset']);
    const ref: DocRef = { tenant: job.tenant, doc };
    await ctx.report('reading', 10);
    const asset = await o.registry.get(job.tenant, assetId);
    if (!asset || asset.state !== 'ready' || asset.sha256 === null)
      throw new JobFailure('not_found', 'the asset is not ready');
    const bytes = await o.assets.getFinal(job.tenant, asset.sha256);
    if (!bytes) throw new JobFailure('not_found', 'the asset has no stored bytes');
    await ctx.report('converting', 40);
    let imported: ImportedDocument;
    try {
      imported = await o.importer(bytes, { signal: ctx.signal });
    } catch (e) {
      throw new JobFailure('validation_failed', `the Word file was refused: ${reasonOf(e)}`);
    }
    await ctx.report('storing', 80);
    const brought = await registerImportedAssets(
      o,
      ref,
      imported,
      job.createdBy,
      (o.now ?? Date.now)(),
    );
    let seq: number;
    try {
      seq = await storeImported(o, ref, imported, job.createdBy, job.id);
    } catch (e) {
      for (const a of brought) await o.registry.remove(job.tenant, a).catch(() => false);
      throw e;
    }
    // The uploaded file is the original: it is attached from the import commit on (EXP-108), and
    // so are the pictures and fragments the import brought.
    await o.registry.attach(job.tenant, doc, assetId, seq);
    for (const a of imported.assets ?? []) await o.registry.attach(job.tenant, doc, a.id, seq);
    return {
      seq,
      asset: assetId,
      warnings: warningsOf(imported.warnings),
      ...(imported.preservation ? { preservation: { ...imported.preservation } } : {}),
    };
  };
}

/**
 * Notifications and webhooks for a settled import (EXP-098 criterion 3), and the `import` version
 * of a completed one (criterion 2).
 */
export function importHooks(opts: {
  notify: () => NotifyFn | undefined;
  events: EventSink;
  now: () => number;
  versions?: Pick<VersionStorePort, 'create'>;
  versionFailed?: (job: JobRecord) => void;
}): JobHooks {
  const tell = (job: JobRecord, type: string, data: Record<string, unknown>) => {
    if (!job.doc) return;
    opts.notify()?.(
      { tenant: job.tenant, doc: job.doc },
      { type, resource: `/imports/${job.id}`, data },
      { user: job.createdBy },
    );
  };
  return {
    settled(job, outcome) {
      if (job.kind !== IMPORT_KIND || !job.doc) return;
      if (outcome.state === 'completed') {
        const seq = typeof outcome.result['seq'] === 'number' ? outcome.result['seq'] : 0;
        tell(job, 'import.completed', { state: 'completed', seq });
        opts.events.emit({
          type: 'dep.import.completed.v1',
          tenant: job.tenant,
          subject: job.doc,
          data: { seq, job: job.id },
          time: opts.now(),
        });
        opts.versions
          ?.create(
            { tenant: job.tenant, doc: job.doc },
            {
              seq,
              kind: 'import',
              ...(typeof outcome.result['asset'] === 'string'
                ? { note: `${ORIGINAL_NOTE} ${outcome.result['asset']}` }
                : {}),
              createdBy: job.createdBy,
              createdAt: opts.now(),
            },
          )
          .then(
            (r) => {
              if (!r.ok) opts.versionFailed?.(job);
            },
            () => opts.versionFailed?.(job),
          );
      } else if (outcome.state === 'failed' && !outcome.retried) {
        tell(job, 'import.failed', { state: 'failed', code: outcome.error.code });
        opts.events.emit({
          type: 'dep.import.failed.v1',
          tenant: job.tenant,
          subject: job.doc,
          data: { seq: 0, job: job.id, code: outcome.error.code },
          time: opts.now(),
        });
      }
    },
  };
}

/** The job as the API shows it: the state, and the warnings or the error once it has ended. */
function importJobOf(job: JobRecord): ImportJob & Record<string, unknown> {
  const result = job.result;
  return {
    id: job.id,
    doc: job.doc,
    state: job.state,
    ...(job.state === 'running' && job.stage ? { stage: job.stage } : {}),
    ...(job.state === 'completed' && result
      ? {
          seq: result['seq'],
          warnings: (result['warnings'] as Array<Record<string, unknown>> | undefined) ?? [],
          ...(result['preservation'] ? { preservation: result['preservation'] } : {}),
        }
      : {}),
    ...(job.state === 'failed' && job.error
      ? { error: { code: job.error.code, message: job.error.message } }
      : {}),
    createdAt: formatTimestamp(job.createdAt),
    updatedAt: formatTimestamp(job.updatedAt),
  };
}

export function importRoutes(k: Kit): Record<string, Handler> {
  const { d, rest, refOf, liveDocument } = k;

  const createImport: Handler = async (ctx) => {
    if (!d.importsOffered)
      throw new ApiError('not_found', 'this server does not import Word files');
    const doc = ctx.params['id']!;
    await liveDocument(ctx, doc);
    const body = (await ctx.body()) as CreateImportRequest;
    if (body.format !== 'docx')
      throw new ApiError('validation_failed', 'only docx can be imported', {
        violations: [{ path: '/format', rule: 'docx' }],
      });
    const asset = await d.assetRegistry?.get(ctx.caller.tenant, body.asset);
    if (!asset || asset.doc !== doc) throw new ApiError('not_found', `no asset ${body.asset}`);
    if (asset.state !== 'ready')
      throw new ApiError('conflict', 'the asset has not been accepted by the asset worker yet');
    if (asset.contentType !== DOCX_CONTENT_TYPE)
      throw new ApiError('validation_failed', 'the asset is not a Word file', {
        violations: [{ path: '/asset', rule: 'a .docx asset' }],
      });
    // An import replaces the content, so it is refused while that would change an approved region
    // or a workflow is active (07 §11; the job checks again when it stores).
    const ref = refOf(ctx, doc);
    const perms = await d.grants.current(ref);
    if (perms.workflowActive)
      throw new ApiError('workflow_active', 'a workflow is active; its content cannot be replaced');
    const current = await d.content.read(ref, { conn: null });
    for (const [rid, state] of perms.regionStates)
      if (state === 'approved' && regionNodeOf(current.doc, rid))
        throw new ApiError(
          'conflict',
          `region ${rid} is approved; change its state first (07 §11)`,
        );
    const job = await d.queue.enqueue(ctx.caller.tenant, {
      kind: IMPORT_KIND,
      doc,
      createdBy: ctx.caller.actor,
      maxAttempts: 1,
      payload: {
        doc,
        asset: body.asset,
        format: body.format,
        traceparent: `00-${ctx.trace.traceId}-${ctx.trace.spanId}-01`,
      },
    });
    d.onJobQueued?.();
    return json(202, importJobOf(job), {
      Location: `${rest}/imports/${job.id}`,
      'Cache-Control': 'no-store',
    });
  };

  /** The job, if the caller may read it: a service credential, or the author it was queued for. */
  async function readableJob(ctx: Ctx): Promise<JobRecord> {
    const job = await d.queue.get(ctx.caller.tenant, ctx.params['jid']!);
    if (!job || job.kind !== IMPORT_KIND || !job.doc)
      throw new ApiError('not_found', `no import job ${ctx.params['jid']}`);
    if (ctx.caller.kind === 'service') return job;
    // A job of a document the token does not cover, or of another author, is answered as a
    // missing one is (owner decision 57; SEC-016 criterion 4).
    if (hiddenFrom(ctx.caller, job.doc) || job.createdBy !== ctx.caller.actor)
      throw new ApiError('not_found', `no import job ${ctx.params['jid']}`);
    capabilitiesOn(ctx.caller, job.doc);
    return job;
  }

  const getImport: Handler = async (ctx) => {
    const job = await readableJob(ctx);
    return json(200, importJobOf(job), {
      ETag: `"i${job.updatedAt}.${job.state}"`,
      'Cache-Control': 'no-store',
    });
  };

  return { createImport, getImport };
}
