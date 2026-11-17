/**
 * `POST /documents/{id}/restore` for a whole document (05 section 6.2; 08 section 8; 07 section 13;
 * HIS-019 criterion 1; lane V-HIS-017-032).
 *
 * The steps, in order (HIS-019):
 * 1. the caller needs `manage` for the document (07 section 12);
 * 2. the document has no active workflow (`workflow_active`, 12 section 10);
 * 3. `toSeq` names a seq at or below the head, and the caller's history gate allows it
 *    (`not_found` above the head, `forbidden` below the gate);
 * 4. no approved region would change (`conflict`, 07 section 11; the same rule as a snapshot);
 * 5. a `pre-restore` version is recorded at the head;
 * 6. the content at `toSeq` is stored as a snapshot commit with reason `restore` (the data plane
 *    resets the open channels; history is not rewritten; grants are not touched);
 * 7. a `restore` version is recorded at the new seq.
 *
 * Not served here, and refused with a reason rather than guessed (each has its own story):
 * - `region` (HIS-018: a region restore needs the steps of `@docedit/history`, which this service
 *   does not depend on yet);
 * - `dryRun` (HIS-021: the answer is the comparison of HIS-011, which the service does not build).
 *
 * The response is `{ seq, toSeq, preRestoreSeq }`. The schema names `RestoreResult` as a
 * placeholder, so the members are a decision of this lane (docs/adr/0358-lane-V-HIS-017-032.md).
 */
import { canonicalize } from '@docedit/model';
import { regionNodeOf } from './content.ts';
import { minVisibleSeqOf, regionInfosOfJson } from './gate.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Ctx, type Handler } from './pipeline.ts';
import { admitRestCommit } from './live-quota-rest.ts';
import { ApiError } from './problems.ts';
import type { JsonEnvelope } from '@docedit/model';

/** The body of `POST /documents/{id}/restore` as this module reads it (05 section 6.2). */
interface RestoreBody {
  toSeq: number;
  region?: string;
  dryRun?: boolean;
}

function readBody(raw: unknown): RestoreBody {
  if (!raw || typeof raw !== 'object')
    throw new ApiError('validation_failed', 'the body must be an object');
  const b = raw as Record<string, unknown>;
  const toSeq = b['toSeq'];
  if (typeof toSeq !== 'number' || !Number.isSafeInteger(toSeq) || toSeq < 0)
    throw new ApiError('validation_failed', 'toSeq must be a non-negative integer');
  if (b['region'] !== undefined && typeof b['region'] !== 'string')
    throw new ApiError('validation_failed', 'region must be a string');
  if (b['dryRun'] !== undefined && typeof b['dryRun'] !== 'boolean')
    throw new ApiError('validation_failed', 'dryRun must be a boolean');
  return {
    toSeq,
    ...(typeof b['region'] === 'string' ? { region: b['region'] } : {}),
    ...(typeof b['dryRun'] === 'boolean' ? { dryRun: b['dryRun'] } : {}),
  };
}

export function restoreRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument, emit } = k;

  const restoreDocument: Handler = async (ctx: Ctx) => {
    const doc = ctx.params['id']!;
    guard(ctx.caller, 'manage', doc);
    const record = await liveDocument(ctx, doc);
    const body = readBody(await ctx.body());
    if (body.region !== undefined)
      throw new ApiError(
        'not_found',
        'a region restore is not offered by this service yet (HIS-018)',
      );
    if (body.dryRun)
      throw new ApiError('not_found', 'a dry run is not offered by this service yet (HIS-021)');
    const store = d.versions;
    if (!store) throw new ApiError('not_found', 'versions are not offered by this service');
    const apply = d.dataPlane?.replaceContent?.bind(d.dataPlane);
    if (!apply)
      throw new ApiError('not_found', 'this server does not replace content yet (BE-037)');
    // BE-091: the restore is a commit, so it counts against the tenant's live-use quotas.
    await admitRestCommit(d.liveQuotas, ctx.caller.tenant);

    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    if (body.toSeq > head.seq)
      throw new ApiError('not_found', `no content at seq ${body.toSeq}; the head is ${head.seq}`);
    const perms = await d.grants.current(ref);
    if (perms.workflowActive)
      throw new ApiError(
        'workflow_active',
        'a workflow is active; the document cannot be restored',
      );

    const current = await d.content.rebuild(ref, head.incarnation, head.seq);
    const min = await minVisibleSeqOf({
      caller: ctx.caller,
      ref,
      record,
      head: head.seq,
      regions: regionInfosOfJson(current.doc),
      perms,
      logs: d.logs,
      now: d.now(),
    });
    if (body.toSeq < min)
      throw new ApiError(
        'forbidden',
        `seq ${body.toSeq} is hidden from you by the history gate (07 section 8)`,
      );
    const target = await d.content.rebuild(ref, head.incarnation, body.toSeq);

    // An approved region must stay exactly as approved, even for a restore (07 section 11).
    for (const [rid, state] of perms.regionStates) {
      if (state !== 'approved') continue;
      const before = regionNodeOf(current.doc, rid);
      const after = regionNodeOf(target.doc, rid);
      if (before && (!after || canonicalize(before) !== canonicalize(after)))
        throw new ApiError(
          'conflict',
          `region ${rid} is approved; change its state first (07 section 11)`,
        );
    }

    const actor = ctx.caller.actor;
    const now = d.now();
    const pre = await store.create(
      ref,
      { seq: head.seq, kind: 'pre-restore', createdBy: actor, createdAt: now },
      { minSeq: 0 },
    );
    if (!pre.ok)
      throw new ApiError('internal', `could not record the pre-restore version: ${pre.message}`);

    const envelope = {
      cdm: target.cdm,
      requires: target.requires,
      doc: target.doc,
    } as JsonEnvelope;
    // The request's trace goes with the restore through the outbox and the room (BE-087 criterion 3).
    const traceparent = `00-${ctx.trace.traceId}-${ctx.trace.spanId}-01`;
    const { seq } = await apply(ref, envelope, actor, { reason: 'restore', traceparent });
    k.wrote(ctx, doc, seq);

    const restored = await store.create(
      ref,
      { seq, kind: 'restore', createdBy: actor, createdAt: d.now() },
      { minSeq: 0 },
    );
    if (!restored.ok)
      throw new ApiError('internal', `could not record the restore version: ${restored.message}`);
    // The restore is a content change with its chain head (05 §7), and a version event (PRO-072 criterion 3).
    const chainHead = (await d.logs.state?.(ref))?.chainHead ?? null;
    emit(ctx, 'dep.document.changed', doc, { seq, ...(chainHead !== null ? { chainHead } : {}) });
    emit(ctx, 'dep.version.restored', doc, { seq });
    // The channels hear of it as `version.restored`, besides the `sync.reset` of the snapshot (PRO-036).
    k.notify()?.(ref, {
      type: 'version.restored',
      resource: `/documents/${doc}/versions`,
      data: { seq, toSeq: body.toSeq },
    });
    return json(200, { seq, toSeq: body.toSeq, preRestoreSeq: head.seq });
  };

  // Keyed by the operationId of `spec/dep` (`restore`), as the route table looks handlers up.
  return { restore: restoreDocument };
}
