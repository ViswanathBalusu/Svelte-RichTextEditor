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
 * applied as the steps the plan computes, handed to the room through the outbox as commits of origin
 * `restore` by the person (HIS-018, ADR 0408). Steps that are too large for one commit are split
 * into several linked commits (owner decision 36): consecutive commits of origin `restore` by the
 * same person, bracketed by the `pre-restore` version at the old head and the `restore` version
 * at the last one, each checked against the head the one before made. Steps 5 to 7 are the same.
 *
 * The response of an applied restore is `{ seq, toSeq, preRestoreSeq }` (with `region` for a region,
 * and `notes: { recreated, replaced }` when a definition had to be recreated or replaced, HIS-020).
 * The schema names `RestoreResult` as a placeholder, so the members are a decision of this lane
 * (docs/adr/0358-lane-V-HIS-017-032.md).
 */
import type { Connection } from '@docedit/authority';
import { planRestore, restorePartPreconditions, type RestorePlan } from '@docedit/history';
import { canonicalize, uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { derivedCommitId } from '../data-plane/commit-id.ts';
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
    write: (traceparent: string) => Promise<{ seq: number; commits: number }>,
    toSeq: number,
    region?: string,
    notes?: { recreated: string[]; replaced: string[] },
  ): Promise<Reply> => {
    const store = d.versions;
    if (!store) throw new ApiError('not_found', 'versions are not offered by this service');
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
    const { seq, commits } = await write(traceparent);
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
      data: {
        seq,
        toSeq,
        ...(region !== undefined ? { region } : {}),
        ...(commits > 1 ? { commits } : {}),
      },
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
      // A restore split into linked commits (owner decision 36) says how many (ADR 0408, proposed).
      ...(commits > 1 ? { commits } : {}),
      // HIS-020 criterion 4: the person is told when a definition was recreated or replaced.
      ...(notes !== undefined && (notes.recreated.length > 0 || notes.replaced.length > 0)
        ? { notes }
        : {}),
    });
  };

  /**
   * Hands the parts of a steps plan to the room through the outbox, one commit each in order,
   * each against the head the one before made (owner decision 36). The commit identifiers are
   * derived from the request, so a retry of the same restore at the same head is the same commits.
   * A part the room refuses stops the restore: the parts before it stay applied, history only moves
   * forward, and the answer says how far it got.
   */
  const writeSteps = async (
    ctx: Ctx,
    ref: DocRef,
    headSeq: number,
    plan: Extract<RestorePlan, { kind: 'steps' }>,
    body: RestoreBody,
    traceparent: string,
  ): Promise<{ seq: number; commits: number }> => {
    const outbox = d.outbox!;
    const actor = ctx.caller.actor;
    let last = headSeq;
    // Control commits the room recorded since the plan (a permission change moves the head without
    // touching content); each moves the base and the head precondition of the parts after it.
    let moved = 0;
    for (const [i, part] of plan.parts.entries()) {
      for (let attempt = 0; ; attempt++) {
        const expected = headSeq + i + moved;
        const item = await outbox.enqueue({
          tenant: ref.tenant,
          doc: ref.doc,
          commitId: derivedCommitId(
            'restore',
            ref.tenant,
            ref.doc,
            actor,
            `head:${headSeq}`,
            `to:${body.toSeq}`,
            `region:${body.region ?? ''}`,
            `part:${i}`,
            `moved:${moved}`,
          ),
          kind: 'author',
          request: {
            origin: 'restore',
            actor,
            base: expected,
            steps: part,
            preconditions: restorePartPreconditions(plan.preconditions, i + moved),
            traceparent,
          },
        });
        const deadline = d.now() + (d.outboxWaitMs ?? 10_000);
        let settled = item;
        while (settled.state === 'pending' && d.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          settled = (await outbox.get(ref.tenant, item.id)) ?? settled;
        }
        const result = settled.result as { code?: string; seq?: number } | null;
        if (settled.state === 'done' && typeof result?.seq === 'number') {
          last = result.seq;
          break;
        }
        const progress = `part ${i + 1} of ${plan.parts.length}; ${i} applied`;
        if (settled.state === 'pending')
          throw new ApiError('unavailable', `the restore was not delivered in time (${progress})`);
        // Only control commits came in: the content is as planned, so try again from the new head.
        const since = result?.code === 'conflict' && attempt < 3 ? await d.logs.read(ref, expected + 1) : [];
        if (since.length > 0 && since.every((c) => c.kind === 'control')) {
          moved += since.length;
          continue;
        }
        throw new ApiError(
          'conflict',
          `the document changed while the restore was applied (${progress}; ${result?.code ?? 'refused'})`,
        );
      }
    }
    return { seq: last, commits: plan.parts.length };
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
          ...(plan.kind === 'steps' ? { commits: plan.parts.length } : {}),
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
    const notes = { recreated: plan.recreated, replaced: plan.replaced };
    if (plan.kind === 'steps') {
      if (!d.outbox)
        throw new ApiError('unavailable', 'server-authored commits are not delivered here');
      // BE-091: the restore is a commit, so it counts against the tenant's live-use quotas.
      await admitRestCommit(d.liveQuotas, ctx.caller.tenant);
      return commitRestore(
        ctx,
        doc,
        v.ref,
        v.head.seq,
        (traceparent) => writeSteps(ctx, v.ref, v.head.seq, plan, body, traceparent),
        body.toSeq,
        body.region,
        notes,
      );
    }
    const replace = d.dataPlane?.replaceContent?.bind(d.dataPlane);
    if (!replace)
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
    return commitRestore(
      ctx,
      doc,
      v.ref,
      v.head.seq,
      async (traceparent) => ({
        seq: (
          await replace(v.ref, envelope, ctx.caller.actor, {
            reason: 'restore',
            traceparent,
            head: String(v.head.seq),
          })
        ).seq,
        commits: 1,
      }),
      body.toSeq,
      body.region,
      notes,
    );
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
    const replace = d.dataPlane.replaceContent.bind(d.dataPlane);
    return commitRestore(
      ctx,
      doc,
      ref,
      head.seq,
      async (traceparent) => ({
        seq: (
          await replace(ref, envelope, ctx.caller.actor, {
            reason: 'restore',
            traceparent,
            head: String(head.seq),
          })
        ).seq,
        commits: 1,
      }),
      body.toSeq,
    );
  };

  // Keyed by the operationId of `spec/dep` (`restore`), as the route table looks handlers up.
  return { restore: restoreDocument };
}
