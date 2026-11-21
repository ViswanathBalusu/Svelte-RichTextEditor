/**
 * The final export of a completed workflow (12 §8.2 step 1, §6.1 `finalisation`, §6.2; FRW-049;
 * docs/adr/0399-w4-FRW-049-final-export.md, proposed).
 *
 * `startFinalExport` runs once the workflow has reached `completed`. It
 *
 * 1. asks `finalExportRequest` (@docedit/authority) what the job must be: pinned to `completedSeq`,
 *    field values flattened, the `final` profile, certificate pages when `finalisation.certificate`
 *    is true;
 * 2. stores the `completed` version at `completedSeq` (08 §4), so the document as it stood at
 *    completion is named and kept;
 * 3. queues an export job for the whole document at that `seq` (never a later head), as a full
 *    export by the service. The job's identifier comes from the document, the workflow, the `seq`
 *    and the certificate option, so a repeat creates no second job. The job belongs to the owner
 *    (the actor who sent the workflow), so a failure reaches their channel as `export.failed`, and
 *    the host receives `dep.export.failed.v1`;
 * 4. records `workflow.finalisation_started` in the audit trail.
 *
 * A job that fails leaves the workflow `completed`: nothing here moves its state, and `finalised` is
 * raised only by the store step of the sealed PDF (FRW-054). The failure is recorded as
 * `workflow.finalisation_failed` by the export hooks (`exportHooks`, control-plane/exports.ts).
 */
import { finalExportRequest, type CertificateFacts } from '@docedit/authority';
import { createHash } from 'node:crypto';
import { canonicalize, uuid7 } from '@docedit/model';
import type { ContentReader } from '../control-plane/content.ts';
import { exportRequestKey, EXPORT_KIND, EXPORT_PRIORITIES } from '../control-plane/exports.ts';
import type { ExportPolicy } from '../control-plane/exports.ts';
import type { JobQueue, JobRecord } from '../control-plane/jobs/queue.ts';
import { withQueueProof } from '../control-plane/job-proof.ts';
import { exportView, readerView, type Views } from '../control-plane/visibility.ts';
import { derivedCommitId } from '../data-plane/commit-id.ts';
import type { AuditStore, DocRef, GrantStore, LogStore } from '../storage/types.ts';
import type { VersionStorePort } from '../storage/versions-memory.ts';
import { certificateFactsOf } from './certificate-facts.ts';
import type { EvidenceLedger } from './evidence-ledger.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

export interface FinalExportDeps {
  readonly logs: LogStore;
  readonly grants: Pick<GrantStore, 'current'>;
  readonly content: Pick<ContentReader, 'rebuild'>;
  readonly views: Views;
  readonly queue: JobQueue;
  readonly policy: ExportPolicy;
  readonly targets: readonly string[];
  readonly versions?: Pick<VersionStorePort, 'create'> | undefined;
  readonly audit?: AuditStore | undefined;
  /** The evidence the certificate prints; without it a certificate cannot be made. */
  readonly evidence?: Pick<EvidenceLedger, 'list' | 'settings'> | undefined;
  readonly now: () => number;
  /**
   * True when this service seals the final PDF: the job then carries the pin of a sealing export
   * (`sealing`), so that the worker compiles twice and compares (EXP-079), and its cache key says so.
   */
  readonly sealing?: boolean | undefined;
  /** Called after a job is queued, so that an in-process runner starts at once. */
  readonly onQueued?: (() => void) | undefined;
}

export type FinalExportOutcome =
  | {
      readonly ok: true;
      readonly job: JobRecord;
      readonly seq: number;
      readonly certificate: boolean;
      /** False when the job already existed. */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** The actor who sent the workflow: the owner, from the audit entry of the transition. */
async function senderOf(
  audit: AuditStore | undefined,
  ref: DocRef,
  fallback: string,
): Promise<string> {
  if (audit === undefined) return fallback;
  const rows = await audit.query(ref.tenant, {
    doc: ref.doc,
    kind: 'workflow.transition',
    limit: 100,
  });
  const sent = rows.find((r) => r.data['to'] === 'sent');
  return sent?.actor ?? fallback;
}

/** The `seq` the workflow completed at: the last completion, or null when no one has completed. */
export function completedSeqOf(workflow: WorkflowResourceView): number | null {
  const seqs = workflow.participants.flatMap((p) =>
    p.state === 'completed' && typeof p.completedSeq === 'number' ? [p.completedSeq] : [],
  );
  return seqs.length === 0 ? null : Math.max(...seqs);
}

/**
 * The identifier of the final export job of a workflow: from the document, the workflow, the `seq`
 * and the certificate option, so that the job can be found again (the seal step, FRW-053) and a
 * repeat of the start makes no second job. Null when no one has completed.
 */
export function finalExportJobId(ref: DocRef, workflow: WorkflowResourceView): string | null {
  const seq = completedSeqOf(workflow);
  if (seq === null) return null;
  return derivedCommitId(
    'final-export',
    ref.tenant,
    ref.doc,
    workflow.id,
    String(seq),
    String(workflow.members.finalisation?.certificate === true),
  );
}

export async function startFinalExport(
  deps: FinalExportDeps,
  req: { ref: DocRef; workflow: WorkflowResourceView; fallbackActor: string },
): Promise<FinalExportOutcome> {
  const { ref, workflow } = req;
  const failed = async (reason: string): Promise<FinalExportOutcome> => {
    await deps.audit?.record([
      {
        id: uuid7(),
        tenant: ref.tenant,
        doc: ref.doc,
        actor: 'system',
        kind: 'workflow.finalisation_failed',
        data: { workflow: workflow.id, stage: 'start', reason },
        at: deps.now(),
      },
    ]);
    return { ok: false, reason };
  };

  const completedSeqs = workflow.participants.flatMap((p) =>
    p.state === 'completed' && typeof p.completedSeq === 'number' ? [p.completedSeq] : [],
  );
  if (completedSeqs.length === 0) return failed('no participant has a completedSeq');
  const completedSeq = Math.max(...completedSeqs);
  const verdict = finalExportRequest(
    workflow.state as Parameters<typeof finalExportRequest>[0],
    completedSeq,
    workflow.members.finalisation,
  );
  if (!verdict.ok) return failed(verdict.reason);
  const { request } = verdict;
  if (!deps.targets.includes('pdf')) return failed('this server has no pdf export target');

  const head = await deps.logs.head(ref);
  if (request.seq > head.seq) return failed(`no content at seq ${request.seq}`);
  const owner = await senderOf(deps.audit, ref, req.fallbackActor);

  // The certificate of completion (FRW-050): the facts it prints, from the evidence, checked and
  // ordered by the authority. They go into the job as a member the control plane alone writes.
  let certificate: CertificateFacts | null = null;
  // The chain head of the history at `completedSeq`: a fact of the certificate and, when the
  // service seals, the pin of the sealing export (EXP-079 criterion 2).
  let chainHead: string | null = null;
  if (request.certificate || deps.sealing === true) {
    const exact = (deps.logs as { chainHeadAt?: (r: DocRef, n: number) => Promise<string | null> })
      .chainHeadAt;
    chainHead = exact
      ? await exact.call(deps.logs, ref, request.seq)
      : head.seq === request.seq
        ? ((await deps.logs.state?.(ref))?.chainHead ?? null)
        : null;
    // A document with no commit yet has no chain head: the hash of its canonical content stands
    // for it, as at the send (docs/adr/0383-w4-FRW-027-send-route.md, point 3).
    if (chainHead === null && request.seq === 0) {
      const at = await deps.content.rebuild(ref, head.incarnation, 0);
      chainHead = createHash('sha256')
        .update(canonicalize({ cdm: at.cdm, requires: at.requires, doc: at.doc }))
        .digest('hex');
    }
    if (chainHead === null) return failed('the log cannot name the chain head at completedSeq');
  }
  if (request.certificate) {
    if (!deps.evidence) return failed('no evidence ledger for the certificate');
    try {
      certificate = certificateFactsOf({
        workflow,
        rows: await deps.evidence.list(ref.tenant, ref.doc),
        completedSeq: request.seq,
        chainHead: chainHead!,
        captureSettings: await deps.evidence.settings?.(ref.tenant),
      });
    } catch (e) {
      return failed(`the certificate facts are not valid: ${String(e)}`);
    }
  }

  // 08 §4: the document as it stood at completion. A second creation for the same seq and kind
  // returns the stored one.
  await deps.versions?.create(ref, {
    seq: request.seq,
    kind: 'completed',
    createdBy: owner,
    createdAt: deps.now(),
  });

  // The whole document at `completedSeq`: the final PDF is the owner's, not a projection.
  const perms = await deps.grants.current(ref);
  const content = await deps.content.rebuild(ref, head.incarnation, request.seq);
  const view = readerView(deps.views, null, content.doc, perms);
  const options = { fields: request.fields, certificate: request.certificate };
  const cacheKey = exportRequestKey({
    tenant: ref.tenant,
    doc: ref.doc,
    incarnation: head.incarnation,
    seq: request.seq,
    view: view.token,
    target: 'pdf',
    // A pair of compiles is a different result from one: a cached ordinary export is not reused.
    options: deps.sealing === true ? { ...options, sealing: true } : options,
    full: true,
    classVersion: deps.policy.classVersion,
  });
  const payload: Record<string, unknown> = {
    doc: ref.doc,
    target: 'pdf',
    seq: request.seq,
    incarnation: head.incarnation,
    options,
    requester: owner,
    role: 'service',
    full: true,
    profile: request.profile,
    classVersion: deps.policy.classVersion,
    // Marks the job as the final export of this workflow, for the hooks that record its outcome.
    finalisation: { workflow: workflow.id, certificate: request.certificate },
    ...(certificate ? { certificate } : {}),
    // The pin of a sealing export: the worker compiles twice and compares (EXP-079).
    ...(deps.sealing === true && chainHead !== null
      ? { sealing: { completedSeq: request.seq, chainHead } }
      : {}),
    ...exportView(view),
  };
  const id = derivedCommitId(
    'final-export',
    ref.tenant,
    ref.doc,
    workflow.id,
    String(request.seq),
    String(request.certificate),
  );
  const before = await deps.queue.get(ref.tenant, id);
  const job = await deps.queue.enqueue(ref.tenant, {
    id,
    ifAbsent: true,
    kind: EXPORT_KIND,
    doc: ref.doc,
    createdBy: owner,
    priority: EXPORT_PRIORITIES[EXPORT_KIND]!,
    cacheKey,
    payload: deps.policy.proofKey
      ? withQueueProof(
          deps.policy.proofKey,
          { tenant: ref.tenant, kind: EXPORT_KIND, doc: ref.doc, cacheKey },
          payload,
        )
      : payload,
  });
  const created = before === null;
  if (created) {
    deps.onQueued?.();
    await deps.audit?.record([
      {
        id: uuid7(),
        tenant: ref.tenant,
        doc: ref.doc,
        actor: 'system',
        kind: 'workflow.finalisation_started',
        data: {
          workflow: workflow.id,
          job: job.id,
          seq: request.seq,
          certificate: request.certificate,
        },
        at: deps.now(),
      },
    ]);
  }
  return { ok: true, job, seq: request.seq, certificate: request.certificate, created };
}
