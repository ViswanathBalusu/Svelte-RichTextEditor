/**
 * `POST /documents/{id}/restore` for a whole document or one region, and its dry run (05 section
 * 6.2; 08 section 8; 07 section 13; HIS-018, HIS-019, HIS-021; PRO-056).
 *
 * A whole-document restore, in order (HIS-019):
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
 * A region restore and every dry run are planned by `planRestore` of `@docedit/history` (HIS-018,
 * HIS-021), which makes the gate, capability, approval, lease and workflow checks. A dry run
 * stores nothing and answers with the comparison between the head and the result. A region restore
 * needs `edit` in that region, which is not approved and not leased to someone else; it is
 * applied as a snapshot commit of the current document with only that region restored, because the
 * control plane has no way to hand a steps commit to the room (decision in
 * docs/adr/0374-w5-PRO-056-region-restore.md, proposed). Steps 5 to 7 are the same.
 *
 * The response of an applied restore is `{ seq, toSeq, preRestoreSeq }` (with `region` for a region).
 * The schema names `RestoreResult` as a placeholder, so the members are a decision of this lane
 * (docs/adr/0358-lane-V-HIS-017-032.md).
 */
import type { Connection } from '@docedit/authority';
import { planRestore } from '@docedit/history';
import { canonicalize, uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { regionNodeOf } from './content.ts';
import {
  accessOf,
  minVisibleSeqOf,
  refuseBelowGate,
  regionInfosOfJson,
  requireRow,
} from './gate.ts';
import { checkSeq, historyViewOf, nameUsers, problemOf } from './history-reads.ts';
import { json, type Kit } from './kit.ts';
import { guard, type Ctx, type Handler, type Reply } from './pipeline.ts';
import { admitRestCommit } from './live-quota-rest.ts';
import { ApiError } from './problems.ts';
import type { JsonEnvelope } from '@docedit/model';
import type { DocRef } from '../storage/types.ts';

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

/** The connection a service credential plans a restore with: the tenant acts as an owner. */
const serviceConnection = (actor: string): Connection => ({
  sub: actor,
  session: '',
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
});

export function restoreRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument, emit } = k;
  const schema = cdmSchema();

  /**
   * Records the pre-restore version, stores `envelope` as a snapshot commit with reason `restore`,
   * records the restore version and raises the events (steps 5 to 7 above).
   */
  const commitRestore = async (
    ctx: Ctx,
    doc: string,
    ref: DocRef,
    headSeq: number,
    envelope: JsonEnvelope,
    toSeq: number,
    region?: string,
  ): Promise<Reply> => {
    const store = d.versions;
    const apply = d.dataPlane?.replaceContent?.bind(d.dataPlane);
    if (!store) throw new ApiError('not_found', 'versions are not offered by this service');
    if (!apply)
      throw new ApiError('not_found', 'this server does not replace content yet (BE-037)');
    const actor = ctx.caller.actor;
    const pre = await store.create(
      ref,
      { seq: headSeq, kind: 'pre-restore', createdBy: actor, createdAt: d.now() },
      { minSeq: 0 },
    );
    if (!pre.ok)
      throw new ApiError('internal', `could not record the pre-restore version: ${pre.message}`);
    // The request's trace goes with the restore through the outbox and the room (BE-087 criterion 3).
    const traceparent = `00-${ctx.trace.traceId}-${ctx.trace.spanId}-01`;
    const { seq } = await apply(ref, envelope, actor, {
      reason: 'restore',
      traceparent,
      head: String(headSeq),
    });
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
      data: { seq, toSeq, ...(region !== undefined ? { region } : {}) },
    });
    // A restore is on the audit trail (07 section 14; UX-081 criterion 1): who, which document and
    // the sequence numbers. No content is recorded.
    await d.audit?.record([
      {
        id: uuid7(),
        tenant: ctx.caller.tenant,
        doc,
        actor,
        kind: 'document.restored',
        data: {
          scopes: region !== undefined ? [region] : ['doc'],
          toSeq,
          seq,
          preRestoreSeq: headSeq,
        },
        at: d.now(),
      },
    ]);
    return json(200, {
      seq,
      toSeq,
      preRestoreSeq: headSeq,
      ...(region !== undefined ? { region } : {}),
    });
  };

  /** A region restore or a dry run: planned by `planRestore`, applied only when it is not a dry run. */
  const restorePlanned = async (ctx: Ctx, doc: string, body: RestoreBody): Promise<Reply> => {
    const v = await historyViewOf(k, ctx, doc);
    checkSeq(body.toSeq, v.gate);
    const target = await d.content.rebuild(v.ref, v.head.incarnation, body.toSeq);
    const actor = ctx.caller.actor;
    const now = d.now();
    const access = accessOf(
      v.conn ?? serviceConnection(actor),
      regionInfosOfJson(v.headDoc),
      v.perms,
      now,
    );
    if (body.region !== undefined) {
      const regions = regionInfosOfJson(v.headDoc);
      // Nobody who lacks `edit` everywhere can restore a region, so such a caller learns nothing
      // about the region (HIS-018; 07 §12); the plan then checks `edit` in that region. The row
      // `version.create` is the matrix's "edit somewhere in the document".
      requireRow(ctx.caller, 'version.create', doc, regions, v.perms, now);
      if (!regions.some((r) => r.id === body.region))
        throw new ApiError('not_found', `no region ${body.region}`);
    }
    const retired = new Set(await d.grants.retired(v.ref));
    const planned = planRestore(
      {
        toSeq: body.toSeq,
        ...(body.region !== undefined ? { region: body.region } : {}),
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      },
      {
        schema,
        head: { seq: v.head.seq, doc: schema.nodeFromJSON(v.headDoc) },
        target: (seq) =>
          seq === body.toSeq ? { doc: schema.nodeFromJSON(target.doc) } : undefined,
        gate: v.gate,
        hidden: v.hiddenIn(v.headDoc, target.doc),
        access,
        user: actor,
        regionStates: v.perms.regionStates,
        leasedToSomeoneElse: (region) =>
          v.perms.leases.some(
            (l) => l.region === region && l.holder !== actor && l.expiresAt > now,
          ),
        workflowActive: v.perms.workflowActive,
        retired,
      },
    );
    if (!planned.ok) throw problemOf(planned);
    const plan = planned.plan;
    if (body.dryRun) {
      // HIS-021: what would change, and nothing stored, sent or recorded.
      return json(
        200,
        {
          dryRun: true,
          toSeq: body.toSeq,
          headSeq: v.head.seq,
          ...(body.region !== undefined ? { region: body.region } : {}),
          kind: plan.kind,
          unchanged: plan.unchanged,
          notes: {
            reidentified: plan.reidentified,
            recreated: plan.recreated,
            replaced: plan.replaced,
          },
          comparison: plan.dryRun ? await nameUsers(k, ctx, plan.dryRun) : null,
        },
        { 'Cache-Control': 'no-store' },
      );
    }
    if (plan.unchanged)
      return json(200, {
        seq: v.head.seq,
        toSeq: body.toSeq,
        unchanged: true,
        ...(body.region !== undefined ? { region: body.region } : {}),
      });
    if (!d.dataPlane?.replaceContent)
      throw new ApiError('not_found', 'this server does not replace content yet (BE-037)');
    // BE-091: the restore is a commit, so it counts against the tenant's live-use quotas.
    await admitRestCommit(d.liveQuotas, ctx.caller.tenant);
    // The plan was made at this head; a commit that landed since would be overwritten (ADR 0374).
    const now2 = await d.logs.head(v.ref);
    if (now2.seq !== v.head.seq)
      throw new ApiError('conflict', 'the document changed while the restore was planned');
    const envelope = {
      cdm: v.full.cdm,
      requires: v.full.requires,
      doc: plan.result.toJSON(),
    } as JsonEnvelope;
    return commitRestore(ctx, doc, v.ref, v.head.seq, envelope, body.toSeq, body.region);
  };

  const restoreDocument: Handler = async (ctx: Ctx) => {
    const doc = ctx.params['id']!;
    const body = readBody(await ctx.body());
    if (body.region === undefined) guard(ctx.caller, 'manage', doc);
    // A region restore needs `edit` in that region, which `planRestore` checks with the regions.
    else guard(ctx.caller, 'read.history', doc);
    const record = await liveDocument(ctx, doc);
    if (body.region !== undefined || body.dryRun) return restorePlanned(ctx, doc, body);
    const store = d.versions;
    if (!store) throw new ApiError('not_found', 'versions are not offered by this service');
    if (!d.dataPlane?.replaceContent)
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
    refuseBelowGate(body.toSeq, min, head.seq, 'toSeq');
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

    const envelope = {
      cdm: target.cdm,
      requires: target.requires,
      doc: target.doc,
    } as JsonEnvelope;
    return commitRestore(ctx, doc, ref, head.seq, envelope, body.toSeq);
  };

  // Keyed by the operationId of `spec/dep` (`restore`), as the route table looks handlers up.
  return { restore: restoreDocument };
}
