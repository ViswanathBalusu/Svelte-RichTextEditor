/**
 * Export and preview jobs (05 §6.2; 09 §9.1; EXP-004 to EXP-008, EXP-123; BE-050, BE-051; review
 * SR-C4; D68, D69, D144). See exports.ts for the kinds, the request key and the preview window.
 */
import { formatTimestamp, uuid7 } from '@docedit/model';
import type { CreateExportRequest, ExportJob } from '@docedit/protocol';
import { objectKeys } from '../objects/store.ts';
import { hasSuggestions } from './content.ts';
import {
  EXPORT_KIND,
  EXPORT_PRIORITIES,
  LOCALE_PATTERN,
  PDF_STANDARDS,
  PREVIEW_KIND,
  exportRequestKey,
  exportState,
  type ExportOutputs,
  type ExportPolicy,
} from './exports.ts';
import { minVisibleSeqOf, refuseBelowGate, regionInfosOfJson } from './gate.ts';
import { checkIfMatch } from './http.ts';
import type { JobRecord } from './jobs/queue.ts';
import { json, type Kit } from './kit.ts';
import { capabilitiesOn, guard, roleOn, type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { exportView, projectContent, readerView } from './visibility.ts';

/** The defaults of the export policy: 06 §10 names ten seconds; the rest are settings. */
export const EXPORT_POLICY_DEFAULTS: ExportPolicy = {
  previewWindowMs: 10_000,
  cacheMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  classVersion: 'unknown',
  tenantConcurrency: null,
};

export function exportRoutes(k: Kit): Record<string, Handler> {
  const { d, rest, refOf, liveDocument } = k;
  const policy = d.exportPolicy ?? EXPORT_POLICY_DEFAULTS;

  const createExport: Handler = async (ctx) => {
    const doc = ctx.params['id']!;
    // Row 12 of 07 §12: `view`, unless restricted with `no-export`.
    guard(ctx.caller, 'export', doc);
    // The tenant's monthly compile-minute budget (EXP-009 criterion 2): refused before any job.
    const spent = d.compileBudget?.refusal(ctx.caller.tenant, d.now());
    if (spent)
      throw new ApiError(
        'quota_exceeded',
        'the tenant has used its compile minutes for this month',
        {
          retryAfterS: spent.retryAfterS,
        },
      );
    const identity = ctx.caller.identity;
    const record = await liveDocument(ctx, doc);
    const body = (await ctx.body()) as CreateExportRequest & {
      options?: { full?: boolean; profile?: string };
    };
    if (!d.exportTargets.includes(body.target))
      throw new ApiError('validation_failed', `the target ${body.target} is not supported here`, {
        violations: [{ path: '/target', rule: `one of ${d.exportTargets.join(', ')}` }],
      });
    // The options the published schema restricts beyond its types (EXP-005 criteria 3, 4).
    const given = (body.options ?? {}) as Record<string, unknown>;
    if (given['pdfStandard'] !== undefined && !PDF_STANDARDS.includes(String(given['pdfStandard'])))
      throw new ApiError('validation_failed', 'the pdfStandard is not in the published schema', {
        violations: [{ path: '/options/pdfStandard', rule: `one of ${PDF_STANDARDS.join(', ')}` }],
      });
    if (given['locale'] !== undefined && !LOCALE_PATTERN.test(String(given['locale'])))
      throw new ApiError('validation_failed', 'the locale is not a language tag', {
        violations: [{ path: '/options/locale', rule: 'a BCP 47 language tag' }],
      });
    // The tenant's data-loss prevention hook is asked before the export starts (UX-086). An allow
    // lets it go on. A deny refuses it with the hook's reason. An unanswered hook refuses it too:
    // fail closed, a proposed decision (docs/adr/0330-lane-U-UX-076-090.md, section 4). Each refusal
    // is audited, with the action, the target and the reason or cause.
    if (d.policyHook) {
      const outcome = await d.policyHook.ask({
        document: doc,
        actor: ctx.caller.actor,
        action: 'export',
        target: body.target,
        classification: record.label ?? null,
      });
      if (outcome.kind === 'unanswered') {
        await d.audit?.record([
          {
            id: uuid7(),
            tenant: ctx.caller.tenant,
            doc,
            actor: ctx.caller.actor,
            kind: 'policy_hook.unanswered',
            data: { action: 'export', target: body.target, cause: outcome.cause },
            at: d.now(),
          },
        ]);
        throw new ApiError(
          'unavailable',
          'the data-loss prevention hook did not answer; the export is not started',
        );
      }
      if (!outcome.decision.allow) {
        await d.audit?.record([
          {
            id: uuid7(),
            tenant: ctx.caller.tenant,
            doc,
            actor: ctx.caller.actor,
            kind: 'policy_hook.refused',
            data: { action: 'export', target: body.target, reason: outcome.decision.reason },
            at: d.now(),
          },
        ]);
        throw new ApiError('forbidden', outcome.decision.reason);
      }
    }
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const seq = body.seq ?? head.seq;
    if (seq > head.seq)
      throw new ApiError('validation_failed', `no content at seq ${seq}; the head is ${head.seq}`, {
        violations: [{ path: '/seq', rule: 'at most the head' }],
      });
    const options = { ...(body.options ?? {}) } as Record<string, unknown>;
    // The default of `fields` is `flatten` (09 §9.1; EXP-005 criterion 5). It is set here, so that
    // the job, its request key and the bundle all record the value that was used.
    if (options['fields'] === undefined) options['fields'] = 'flatten';
    const full = options['full'] === true;
    const role = roleOn(ctx.caller, doc);
    // A full export needs `manage` and the explicit option (EXP-123 criterion 1).
    if (full && role !== null) guard(ctx.caller, 'manage', doc);
    const perms = await d.grants.current(ref);
    const headDoc = await d.content.rebuild(ref, head.incarnation, head.seq);
    // The `seq` option is a place that takes a sequence number: the history gate (07 §8; PRM-041).
    if (seq < head.seq && identity)
      refuseBelowGate(
        seq,
        await minVisibleSeqOf({
          caller: ctx.caller,
          ref,
          record,
          head: head.seq,
          regions: regionInfosOfJson(headDoc.doc),
          perms,
          logs: d.logs,
          now: d.now(),
        }),
        head.seq,
      );
    // The export is of what the requester may read (EXP-123; SR-C4).
    const content =
      seq === head.seq ? headDoc : await d.content.rebuild(ref, head.incarnation, seq);
    const view = readerView(
      d.views,
      identity && role && !full ? { ...identity.connection, role } : null,
      content.doc,
      perms,
    );
    if (options['suggestions'] === undefined && hasSuggestions(projectContent(view, content.doc)))
      throw new ApiError(
        'pending_suggestions',
        'the content has unresolved suggestions; set options.suggestions',
      );
    const kind = options['profile'] === 'preview' ? PREVIEW_KIND : EXPORT_KIND;
    const cacheKey = exportRequestKey({
      tenant: ctx.caller.tenant,
      doc,
      incarnation: head.incarnation,
      seq,
      view: view.token,
      target: body.target,
      options,
      full: full || ctx.caller.kind === 'service',
      classVersion: policy.classVersion,
    });
    const now = d.now();
    const payload = {
      doc,
      target: body.target,
      seq,
      incarnation: head.incarnation,
      options,
      requester: ctx.caller.actor,
      role: role ?? 'service',
      full: full || ctx.caller.kind === 'service',
      profile: kind === PREVIEW_KIND ? 'preview' : 'final',
      classVersion: policy.classVersion,
      ...exportView(view),
    };
    const accepted = (job: JobRecord) =>
      json(202, exportJobOf(job, false, now + d.signedUrlMs), {
        Location: `${rest}/exports/${job.id}`,
        'Cache-Control': 'no-store',
      });

    // The first result of the same request answers it without a compile (EXP-006). The copy is a
    // job of this requester; it names the job whose files it shows, and carries the raw log only
    // when the requester is the same (EXP-123 criterion 4).
    const cached = await d.queue.findCompleted(
      ctx.caller.tenant,
      cacheKey,
      now - policy.cacheMaxAgeMs,
    );
    if (cached?.result) {
      const out = cached.result as unknown as ExportOutputs;
      const copy: ExportOutputs = {
        ...out,
        from: out.from ?? cached.id,
        log: cached.createdBy === ctx.caller.actor ? (out.log ?? null) : null,
      };
      const job = await d.queue.enqueue(ctx.caller.tenant, {
        kind,
        doc,
        createdBy: ctx.caller.actor,
        priority: EXPORT_PRIORITIES[kind]!,
        cacheKey,
        payload: { ...payload, cachedFrom: cached.id },
        completedWith: copy as unknown as Record<string, unknown>,
      });
      return accepted(job);
    }

    // At most one preview compile per document per window (06 §10; BE-051; EXP-008). The window
    // is in the queue's clock: it ends at the latest preview's `createdAt` plus the window, and the
    // queue holds the new job until then. This node's clock is not compared with the queue's, which
    // for PostgreSQL is the database's (06 §2.1).
    let notBefore: number | undefined;
    if (kind === PREVIEW_KIND) {
      const latest = await d.queue.latestFor(ctx.caller.tenant, doc, PREVIEW_KIND);
      if (latest) {
        const pending = latest.state === 'queued' || latest.state === 'running';
        if (pending && latest.createdBy === ctx.caller.actor && latest.cacheKey === cacheKey)
          return accepted(latest);
        // A newer preview of the same requester replaces their older one that has not started.
        if (latest.state === 'queued' && latest.createdBy === ctx.caller.actor)
          await d.queue.cancel(ctx.caller.tenant, latest.id);
        notBefore = latest.createdAt + policy.previewWindowMs;
      }
    }
    const job = await d.queue.enqueue(ctx.caller.tenant, {
      kind,
      doc,
      createdBy: ctx.caller.actor,
      priority: EXPORT_PRIORITIES[kind]!,
      cacheKey,
      // The request's trace goes with the job, so that its run is part of it (BE-087 criterion 4).
      payload: { ...payload, traceparent: `00-${ctx.trace.traceId}-${ctx.trace.spanId}-01` },
      ...(notBefore !== undefined ? { notBefore } : {}),
    });
    d.onJobQueued?.();
    k.notify()?.(
      ref,
      { type: 'export.progress', resource: `/exports/${job.id}`, data: { state: 'queued' } },
      { user: ctx.caller.actor },
    );
    return accepted(job);
  };

  /** The job, if the caller may read it: its requester or a service credential (D69). */
  async function ownJob(ctx: Ctx): Promise<{ job: JobRecord; canSeeLog: boolean }> {
    const job = await d.queue.get(ctx.caller.tenant, ctx.params['jid']!);
    if (!job || (job.kind !== EXPORT_KIND && job.kind !== PREVIEW_KIND) || !job.doc)
      throw new ApiError('not_found', `no export job ${ctx.params['jid']}`);
    if (ctx.caller.kind === 'service') return { job, canSeeLog: true };
    // Row 12 of 07 §12 for the job's document, then the requester rule of SR-C4 (D69).
    guard(ctx.caller, 'export', job.doc);
    if (job.createdBy !== ctx.caller.actor)
      throw new ApiError('forbidden', 'an export job belongs to its requester (SR-C4; D69)');
    const caps = capabilitiesOn(ctx.caller, job.doc);
    return { job, canSeeLog: caps === 'all' || caps.has('edit') };
  }

  function exportJobOf(job: JobRecord, canSeeLog: boolean, expiresAt: number): ExportJob {
    const out = job.result as ExportOutputs | null;
    // A cached result's files are under the prefix of the job that made them (EXP-006).
    const owner = out?.from ?? job.id;
    const key = (name: string) => objectKeys.exportFile(job.tenant, owner, name);
    const sign = (name: string) => d.assets.signedUrl(job.tenant, key(name), expiresAt);
    const payload = job.payload as { target: ExportJob['target']; seq: number };
    return {
      id: job.id,
      doc: job.doc!,
      target: payload.target,
      seq: payload.seq,
      state: exportState(job),
      progress: job.progress,
      result:
        job.state === 'completed' && out
          ? {
              url: sign(out.output),
              expiresAt: formatTimestamp(expiresAt),
              pages: out.pages ?? null,
              layout: out.layout ? sign(out.layout) : null,
              converged: out.converged ?? null,
              ...(canSeeLog && out.log ? { log: sign(out.log) } : {}),
              // The chain head of the manifest, so that the host can anchor it (08 §12; EXP-011).
              ...(out.chainHead !== undefined ? { chainHead: out.chainHead } : {}),
            }
          : null,
      diagnostics: out?.diagnostics ?? [],
      ...(job.state === 'failed' && job.error
        ? { error: { code: job.error.code as never, message: job.error.message } }
        : {}),
      createdAt: formatTimestamp(job.createdAt),
      updatedAt: formatTimestamp(job.updatedAt),
    };
  }

  const jobEtag = (job: JobRecord) => `"j${job.updatedAt}.${job.state}"`;

  const getExport: Handler = async (ctx) => {
    const { job, canSeeLog } = await ownJob(ctx);
    // A fresh signed URL at every read, also of a cached result (EXP-006 criterion 4).
    return json(200, exportJobOf(job, canSeeLog, d.now() + d.signedUrlMs), {
      ETag: jobEtag(job),
      'Cache-Control': 'no-store',
    });
  };

  const cancelExport: Handler = async (ctx) => {
    const { job } = await ownJob(ctx);
    checkIfMatch(ctx.req, jobEtag(job), false);
    // A finished job is left as it is; a queued or running one ends in `cancelled` (D68).
    const after = await d.queue.cancel(ctx.caller.tenant, job.id);
    if (after && after.state === 'cancelled' && job.state !== 'cancelled')
      k.notify()?.(
        refOf(ctx, job.doc!),
        { type: 'export.cancelled', resource: `/exports/${job.id}`, data: { state: 'cancelled' } },
        { user: job.createdBy },
      );
    return { status: 204 };
  };

  return { createExport, getExport, cancelExport };
}
