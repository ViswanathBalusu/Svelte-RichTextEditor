/**
 * Export and preview jobs (05 §6.2; 09 §8, §9; 06 §8, §10; EXP-004 to EXP-008, EXP-123; BE-050,
 * BE-051; ADR 0054; decision D144).
 *
 * - Previews (`options.profile: "preview"`) are jobs of kind `preview`, requested exports of kind
 *   `export`. A preview has the higher priority, so a worker that serves both takes waiting
 *   previews first, and a deployment can give each kind workers of its own (EXP-007; BE-050).
 * - Every job carries a request key: a SHA-256 over the tenant, the document, the incarnation and
 *   `seq` of the content, the reader's visibility class, the target, the options, whether the
 *   export is full, and the house class version. The converter is deterministic (09 §9.4), so
 *   equal keys mean equal bundles: a second request with the key of a completed job gets that
 *   job's result without a compile (EXP-006). Previews and final exports differ in `profile`, a
 *   new class version changes every key, and the key starts with the tenant, so no result crosses
 *   a tenant. Each request still gets a job of its own, which belongs to its requester (D69).
 * - A preview requested while another preview of the same document was created less than the
 *   preview window ago (06 §10: ten seconds; a setting) starts no compile of its own before the
 *   window ends: the same requester with the same key gets the pending job back, and a different
 *   request waits until the window has passed (BE-051; EXP-008).
 * - An export is of what the requester may read (EXP-123): the job records the requester's class
 *   and hidden scopes, and the worker builds the bundle from that projection. A full export needs
 *   `manage` and `options.full: true`; a service credential reads the full document anyway.
 */
import { createHash } from 'node:crypto';
import { canonicalize, uuid7 } from '@docedit/model';
import type { Diagnostic, Notification } from '@docedit/protocol';
import type { AuditStore, DocRef } from '../storage/types.ts';
import type { EventSink } from './events.ts';
import type { JobHooks, JobOutcome } from './jobs/runner.ts';
import type { JobRecord } from './jobs/queue.ts';
import type { VersionStorePort } from '../storage/versions-memory.ts';

/**
 * What an export worker stores as a job's result (the contract with the compile worker): file
 * names under the job's prefix (`tenants/{tenant}/exports/{job}/`), never URLs. The control plane
 * signs URLs at each read, after the permission check (10 §3.7; D68). A result copied from an
 * earlier job of the same request names that job in `from` (EXP-006; set by the control plane).
 */
export interface ExportOutputs {
  output: string;
  pages?: number | null;
  layout?: string | null;
  converged?: boolean | null;
  log?: string | null;
  diagnostics?: Diagnostic[];
  /**
   * The hash-chain head of the exported state, as the worker wrote it into the export's manifest
   * (08 §12; EXP-011 criterion 5). Null when the log has no commit at that `seq`; absent from a
   * worker that does not report it.
   */
  chainHead?: string | null;
  /**
   * The number of images and figures without alternative text, one per occurrence (09 §13;
   * EXP-113 criterion 2). Absent from a worker that does not report it.
   */
  imagesWithoutAlt?: number;
  /** The job whose prefix holds the files, when it is not this job (a cached result). */
  from?: string;
}

/**
 * The PDF standards the published schema names (`ExportOptions.pdfStandard`, the definition's
 * `known` list; EXP-005 criterion 3). The wire format takes any string, so the service refuses
 * the others with `validation_failed`. Whether the list grows beyond these two is open (see
 * docs/adr/0104-control-plane-backlog-batch.md).
 */
export const PDF_STANDARDS: readonly string[] = ['ua-2', 'a-4'];

/** The locale pattern of the published schema (`ExportOptions.locale`; EXP-005 criterion 4). */
export const LOCALE_PATTERN =
  /^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?|[Xx](?:-[A-Za-z0-9]{1,8})+)$/;

export const EXPORT_KIND = 'export';
export const PREVIEW_KIND = 'preview';
export const EXPORT_KINDS = [EXPORT_KIND, PREVIEW_KIND] as const;

/** Claim priorities (higher first): previews before requested exports (BE-050 criterion 1). */
export const EXPORT_PRIORITIES: Readonly<Record<string, number>> = {
  [PREVIEW_KIND]: 10,
  [EXPORT_KIND]: 0,
};

export interface ExportPolicy {
  /** 06 §10: at most one preview compile per document in this window, ms (default 10 s). */
  previewWindowMs: number;
  /** How old a completed result may be and still answer a new request, ms. */
  cacheMaxAgeMs: number;
  /** The house class version, part of every request key (EXP-006 criterion 3). */
  classVersion: string;
  /** Running jobs of a kind per tenant when the tenant has no limit of its own; null: none. */
  tenantConcurrency: number | null;
  /**
   * The key of the queue proof (EXP-067 criterion 4): when set, every job of an export carries a
   * keyed hash that a worker with the same key checks. Absent: no proof is written.
   */
  proofKey?: string;
}

/** The request key of an export (EXP-006): equal keys give equal bundles. */
export function exportRequestKey(parts: {
  tenant: string;
  doc: string;
  incarnation: string;
  seq: number;
  view: string;
  target: string;
  options: Record<string, unknown>;
  full: boolean;
  classVersion: string;
  /** The document's classification label (EXP-089): printed on the PDF, so part of the key. */
  classification?: string | null;
}): string {
  return createHash('sha256')
    .update(
      canonicalize({
        v: 1,
        tenant: parts.tenant,
        doc: parts.doc,
        incarnation: parts.incarnation,
        seq: parts.seq,
        view: parts.view,
        target: parts.target,
        options: parts.options,
        full: parts.full,
        classVersion: parts.classVersion,
        // Left out when there is no label, so the keys of unlabelled documents do not change.
        ...(parts.classification ? { classification: parts.classification } : {}),
      }),
      'utf8',
    )
    .digest('hex');
}

/** The DEP state of a job (05 §6.2): running jobs report their stage. */
export function exportState(
  job: JobRecord,
): 'queued' | 'converting' | 'compiling' | 'completed' | 'failed' | 'cancelled' {
  if (job.state !== 'running') return job.state;
  return job.stage === 'compiling' ? 'compiling' : 'converting';
}

/** What the data plane offers for notifications on the socket (05 §5.6; seams `notify`). */
export type NotifyFn = (
  ref: DocRef,
  notification: Notification,
  opts?: { user?: string; scopes?: readonly string[] },
) => void;

/**
 * The hooks that turn job progress and outcomes into notifications for the requester's channels
 * (EXP-004 criteria 2, 5: `export.progress`, `export.completed`, `export.failed`) and webhooks
 * (`dep.export.completed.v1`, `dep.export.failed.v1`, with the job and the `seq`).
 */
export function exportHooks(opts: {
  notify: () => NotifyFn | undefined;
  events: EventSink;
  restPath: string;
  now: () => number;
  /** Called with every settled export or preview, for the meters of BE-085. */
  metered?: (job: JobRecord, outcome: JobOutcome, ranMs: number) => void;
  /**
   * Stores the `export` version of a completed export at its `seq` (HIS-007 criterion 1). Absent:
   * no version is recorded. Previews never get one.
   */
  versions?: Pick<VersionStorePort, 'create'>;
  /** Called when the `export` version could not be stored; the export itself stays completed. */
  versionFailed?: (job: JobRecord) => void;
  /**
   * Where the failure of a workflow's final export is recorded (FRW-049 criterion 3): the entry
   * `workflow.finalisation_failed` names the job and the error code, for the operator. The workflow
   * stays `completed`. Absent: no entry.
   */
  audit?: Pick<AuditStore, 'record'>;
  /**
   * Called when the final export of a workflow has completed (a job whose payload has
   * `finalisation`), so that the seal step can start at once (FRW-053). Absent: the scheduled
   * seal step finds the job later.
   */
  finalExportCompleted?: (job: JobRecord) => void;
}): JobHooks {
  const isExport = (j: JobRecord) => (EXPORT_KINDS as readonly string[]).includes(j.kind);
  const tell = (job: JobRecord, type: string, data: Record<string, unknown>) => {
    if (!job.doc) return;
    opts.notify()?.(
      { tenant: job.tenant, doc: job.doc },
      { type, resource: `/exports/${job.id}`, data },
      { user: job.createdBy },
    );
  };
  const recordExportVersion = (job: JobRecord, seq: number, doc: string) => {
    const versions = opts.versions;
    if (!versions) return;
    versions
      .create(
        { tenant: job.tenant, doc },
        { seq, kind: EXPORT_KIND, createdBy: job.createdBy, createdAt: opts.now() },
      )
      .then(
        (outcome) => {
          if (!outcome.ok) opts.versionFailed?.(job);
        },
        () => opts.versionFailed?.(job),
      );
  };
  return {
    progress(job, stage, progress) {
      if (!isExport(job)) return;
      tell(job, 'export.progress', {
        state: stage === 'compiling' ? 'compiling' : 'converting',
        ...(progress !== undefined ? { progress } : {}),
      });
    },
    settled(job, outcome, ranMs) {
      if (!isExport(job) || !job.doc) return;
      opts.metered?.(job, outcome, ranMs);
      const seq = typeof job.payload['seq'] === 'number' ? job.payload['seq'] : 0;
      if (outcome.state === 'completed') {
        tell(job, 'export.completed', { state: 'completed' });
        opts.events.emit({
          type: 'dep.export.completed.v1',
          tenant: job.tenant,
          subject: job.doc,
          data: { seq, job: job.id },
          time: opts.now(),
        });
        if (job.kind === EXPORT_KIND && typeof job.payload['seq'] === 'number' && opts.versions)
          recordExportVersion(job, job.payload['seq'], job.doc);
        if (job.payload['finalisation'] !== undefined) opts.finalExportCompleted?.(job);
      } else if (outcome.state === 'failed' && !outcome.retried) {
        tell(job, 'export.failed', { state: 'failed', code: outcome.error.code });
        const fin = job.payload['finalisation'] as { workflow?: unknown } | undefined;
        if (fin !== undefined && fin !== null && typeof fin === 'object')
          void opts.audit
            ?.record([
              {
                id: uuid7(),
                tenant: job.tenant,
                doc: job.doc,
                actor: 'system',
                kind: 'workflow.finalisation_failed',
                data: {
                  workflow: typeof fin.workflow === 'string' ? fin.workflow : null,
                  stage: 'export',
                  job: job.id,
                  seq,
                  code: outcome.error.code,
                },
                at: opts.now(),
              },
            ])
            .catch(() => undefined);
        opts.events.emit({
          type: 'dep.export.failed.v1',
          tenant: job.tenant,
          subject: job.doc,
          data: { seq, job: job.id, code: outcome.error.code },
          time: opts.now(),
        });
      }
    },
  };
}
