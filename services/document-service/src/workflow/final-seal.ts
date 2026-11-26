/**
 * The live seal step of finalisation (12 §8.2 steps 3 and 4; FRW-052 criterion 5, FRW-053).
 *
 * When the final export of a completed workflow has finished, `sealCompletedWorkflow` takes its
 * PDF out of the object store, with the hashes of the two compiles that the worker compared
 * (EXP-079), and runs `sealAndFinalise`: the signing service seals it, the sealed bytes are stored
 * write-once, the workflow moves to `finalised` and the event `finalised` is raised.
 *
 * It is called from two places, so that a run that stopped, or a process that stopped, is picked up:
 *
 * - the export hook, when the final export job completes (control-plane/exports.ts, server.ts);
 * - the scheduled task `workflow.seal`, which looks at every `completed` workflow of a tenant.
 *
 * What it finds it finds again from the workflow: the final export job has a derived identifier
 * (`finalExportJobId`). A workflow whose export has not finished is left alone; one whose sealing
 * export failed stops with an alert (EXP-079 criterion 4; below). Other failed exports are left alone (a
 * failed export is already audited and reported by the export hooks).
 *
 * One run at a time for one workflow in this process (`FinalSealer`). Across processes the rules
 * of the stores hold: the signing service binds a document and `seq` to one hash, the sealed store
 * refuses a second write, and `finaliseSealed` refuses a workflow that is not `completed`.
 *
 * When the run stops the workflow stays `completed`, the failure is audited and the operator alert
 * is raised (`sealAndFinalise`, `stopFinalisation`). A stop that asking again cannot mend (a refused
 * request, a PDF with no equal pair of compiles) is remembered in this process and is not retried
 * by the scheduled task; a stop that can pass is run again at the next task run. Nothing here is
 * stored: a restart forgets which stops were final and tries them once more.
 */
import { createHash } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import type { EventSink } from '../control-plane/events.ts';
import type { JobQueue, JobRecord } from '../control-plane/jobs/queue.ts';
import { objectKeys, type ObjectStore } from '../objects/store.ts';
import type { DocRef } from '../storage/types.ts';
import { ANCHOR_FILE_FORMAT, type AnchorStore } from './anchor-store.ts';
import { finalExportJobId } from './final-export-start.ts';
import type { AppearanceRequest } from './signing-client.ts';
import { raiseWorkflowEvents } from './raise-events.ts';
import { recordFirstExpiry, type RenewalRegistry } from './renewal-schedule.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';
import {
  sealAndFinalise,
  stopFinalisation,
  type SealAndFinaliseDeps,
  type SealAndFinaliseOutcome,
} from './seal-and-finalise.ts';

export interface FinalSealDeps extends SealAndFinaliseDeps {
  /** Where the signed, time-stamped chain head at completion is written once (FRW-054). */
  readonly anchors: AnchorStore;
  readonly objects: Pick<ObjectStore, 'get'>;
  readonly queue: Pick<JobQueue, 'get'>;
  readonly events: EventSink;
  /** How long the stored sealed bytes are retained, ms from now. */
  readonly retainMs: number;
  /**
   * The visible appearances to draw at the signature and initials fields (FRW-057), from the
   * document, the layout and the evidence. Absent: none are drawn.
   */
  readonly appearances?: (
    ref: DocRef,
    workflow: WorkflowResourceView,
    job: JobRecord,
  ) => Promise<AppearanceRequest | undefined>;
  /**
   * Where the end of the seal's time-stamp is recorded for the renewal schedule (FRW-056 criterion
   * 2). Absent: the seal is not renewed by the schedule.
   */
  readonly renewals?: Pick<RenewalRegistry, 'start'>;
  /** Told when recording the first expiry failed; the seal stands. */
  readonly renewalFailed?: (ref: DocRef, error: unknown) => void;
}

export type FinalSealOutcome =
  /** Nothing to seal yet: the reason says what is missing. */
  | { readonly status: 'waiting'; readonly reason: string }
  /** The sealed PDF is stored and the workflow is `finalised`. */
  | { readonly status: 'sealed'; readonly run: Extract<SealAndFinaliseOutcome, { sealed: true }> }
  /** The run stopped; the workflow stays `completed` and the operator was alerted. */
  | { readonly status: 'stopped'; readonly code: string; readonly retryable: boolean }
  /** Another run of this process has the workflow. */
  | { readonly status: 'busy' }
  /** An earlier run stopped for a reason that asking again does not mend. */
  | { readonly status: 'gave_up'; readonly code: string };

interface ExportResult {
  readonly output?: unknown;
  readonly from?: unknown;
  readonly sealing?: { readonly pdfSha256?: { readonly a?: unknown; readonly b?: unknown } };
}

const HEX64 = /^[0-9a-f]{64}$/;

export class FinalSealer {
  readonly #deps: FinalSealDeps;
  readonly #running = new Set<string>();
  /** Workflows whose run stopped for good, by `tenant/doc/workflow`, with the code. */
  readonly #gaveUp = new Map<string, string>();

  constructor(deps: FinalSealDeps) {
    this.#deps = deps;
  }

  async sealCompletedWorkflow(ref: DocRef): Promise<FinalSealOutcome> {
    const deps = this.#deps;
    const workflow = await deps.workflows.read(ref.tenant, ref.doc);
    if (workflow === null || workflow.state !== 'completed')
      return { status: 'waiting', reason: 'the workflow is not completed' };
    const key = `${ref.tenant}/${ref.doc}/${workflow.id}`;
    const earlier = this.#gaveUp.get(key);
    if (earlier !== undefined) return { status: 'gave_up', code: earlier };
    if (this.#running.has(key)) return { status: 'busy' };

    const jobId = finalExportJobId(ref, workflow);
    if (jobId === null) return { status: 'waiting', reason: 'no participant has completed' };
    const job = await deps.queue.get(ref.tenant, jobId);
    if (job === null) return { status: 'waiting', reason: 'no final export job' };
    // A sealing export that failed seals nothing. When its two compiles differed, or it failed for
    // another reason, the workflow stays `completed` and the operator is alerted (EXP-079 criterion
    // 4; the worker's diagnostic `seal_pair_differs`). Asking again does not mend it: the run is
    // remembered, so the alert is raised once.
    if (job.state === 'failed' && job.payload['sealing'] !== undefined) {
      const diagnostics = (job.error as { diagnostics?: ReadonlyArray<{ code?: unknown }> } | null)
        ?.diagnostics;
      const differs = (diagnostics ?? []).some((d) => d.code === 'seal_pair_differs');
      const code = differs ? 'compile_pair_differs' : 'export_failed';
      await stopFinalisation(deps, {
        ref,
        workflow: workflow.id,
        reason: 'seal_failed',
        code,
        attempts: 0,
        retryable: false,
      });
      this.#gaveUp.set(key, code);
      return { status: 'stopped', code, retryable: false };
    }
    if (job.state !== 'completed')
      return { status: 'waiting', reason: `the export is ${job.state}` };

    this.#running.add(key);
    try {
      const stop = async (code: string, retryable: boolean): Promise<FinalSealOutcome> => {
        await stopFinalisation(deps, {
          ref,
          workflow: workflow.id,
          reason: 'seal_failed',
          code,
          attempts: 0,
          retryable,
        });
        if (!retryable) this.#gaveUp.set(key, code);
        return { status: 'stopped', code, retryable };
      };

      const result = (job.result ?? {}) as ExportResult;
      const a = result.sealing?.pdfSha256?.a;
      const b = result.sealing?.pdfSha256?.b;
      if (typeof a !== 'string' || typeof b !== 'string' || !HEX64.test(a) || !HEX64.test(b))
        return stop('no_compile_pair', false);
      if (typeof result.output !== 'string') return stop('no_output', false);
      const owner = typeof result.from === 'string' ? result.from : job.id;
      const pdf = await deps.objects
        .get(objectKeys.exportFile(ref.tenant, owner, result.output))
        .catch(() => null);
      if (pdf === null) return stop('output_missing', true);
      if (createHash('sha256').update(pdf).digest('hex') !== a)
        return stop('output_differs', false);
      const seq = job.payload['seq'];
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)
        return stop('no_seq', false);

      // The chain head at completion is signed and time-stamped and written once (FRW-054
      // criterion 3), before the PDF is sealed. The pin of the job names it.
      const pin = job.payload['sealing'] as { chainHead?: unknown } | undefined;
      const head = pin?.chainHead;
      if (typeof head !== 'string' || !HEX64.test(head)) return stop('no_chain_head', false);
      const anchored = await this.#anchor(ref, workflow.id, seq, head, key);
      if (anchored !== null) return anchored;

      // The appearances are asked for after the compile: they are drawn on the bytes the pair
      // agreed on, so the pair is not affected (FRW-057 criterion 4). A failure to prepare them is
      // not a reason to hold the seal back.
      const appearances = await deps.appearances?.(ref, workflow, job).catch(() => undefined);
      const run = await sealAndFinalise(deps, {
        ref,
        actor: 'system',
        appearances,
        pdf,
        compileSha256: [a, b],
        seq,
        retainUntilMs: deps.now() + deps.retainMs,
      });
      if (!run.ok) return { status: 'waiting', reason: `the workflow is ${run.problem.code}` };
      if (!run.sealed) {
        // `sealAndFinalise` has audited and alerted. A refused request is not asked again.
        if (!run.retryable) this.#gaveUp.set(key, 'seal_refused');
        return { status: 'stopped', code: 'seal_stopped', retryable: run.retryable };
      }
      // The workflow is finalised by now: the host hears of it first, whatever follows.
      await raiseWorkflowEvents(deps, ref, run.final.resource, run.final.control, run.final.raised);
      // The end of the seal's time-stamp is recorded for the renewal schedule (FRW-056 criterion
      // 2). A failure here is not a reason to undo the seal: the renewal then has no start, and
      // the operator sees it in the log of the hook.
      if (deps.renewals)
        await recordFirstExpiry(deps.renewals, ref.tenant, ref.doc, run.expiresAtMs).catch((e) =>
          deps.renewalFailed?.(ref, e),
        );
      // What a signature provider asserted about its level and the signer is on record as asserted
      // by the provider (FRW-059 criterion 3); the platform does not verify it.
      if (run.provider)
        await deps.audit?.record([
          {
            id: uuid7(),
            tenant: ref.tenant,
            doc: ref.doc,
            actor: 'system',
            kind: 'workflow.seal_provider_asserted',
            data: {
              workflow: workflow.id,
              assertedBy: 'provider',
              provider: run.provider.provider,
              signatureLevel: run.provider.level,
              signerIdentification: run.provider.signer,
            },
            at: deps.now(),
          },
        ]);
      // What was not drawn is on record for the operator and the owner (FRW-057 criterion 6). It is
      // written after the events, so that a slow or failing audit store cannot delay or lose them.
      if (run.appearances && run.appearances.diagnostics.length > 0)
        await deps.audit?.record([
          {
            id: uuid7(),
            tenant: ref.tenant,
            doc: ref.doc,
            actor: 'system',
            kind: 'workflow.appearance_diagnostics',
            data: {
              workflow: workflow.id,
              drawn: run.appearances.drawn.length,
              diagnostics: JSON.stringify(
                run.appearances.diagnostics.map((d) => ({ id: d.id, code: d.code })),
              ),
            },
            at: deps.now(),
          },
        ]);
      return { status: 'sealed', run };
    } finally {
      this.#running.delete(key);
    }
  }

  /**
   * Has the signing service sign and time-stamp the chain head and writes the file once. Null when
   * the head is anchored (now or before); an outcome when the run must stop. A failure that can
   * pass is asked again after the delays the caller sets, as the seal is.
   */
  async #anchor(
    ref: DocRef,
    workflow: string,
    seq: number,
    chainHead: string,
    key: string,
  ): Promise<FinalSealOutcome | null> {
    const deps = this.#deps;
    if ((await deps.anchors.read(ref.tenant, ref.doc, workflow)) !== null) return null;
    const stop = async (
      reason: 'tsa_unreachable' | 'signing_unavailable' | 'seal_failed',
      code: string,
      attempts: number,
      retryable: boolean,
    ): Promise<FinalSealOutcome> => {
      await stopFinalisation(deps, {
        ref,
        workflow,
        stage: 'anchor',
        reason,
        code,
        attempts,
        retryable,
      });
      if (!retryable) this.#gaveUp.set(key, code);
      return { status: 'stopped', code, retryable };
    };
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const out = await deps.signing.anchor({
        tenant: ref.tenant,
        documentId: ref.doc,
        workflow,
        seq,
        chainHead,
      });
      if (out.ok) {
        const stored = await deps.anchors.store({
          tenant: ref.tenant,
          doc: ref.doc,
          workflow,
          file: {
            format: ANCHOR_FILE_FORMAT,
            record: out.record,
            recordSha256: out.recordSha256,
            cms: Buffer.from(out.cms).toString('base64'),
            timestampTime: out.timestampTime.toISOString(),
            keyId: out.keyId,
          },
          retainUntilMs: deps.now() + deps.retainMs,
        });
        if (stored.ok) return null;
        return stop(
          'seal_failed',
          stored.reason === 'different_record' ? 'anchor_differs' : 'anchor_store_failed',
          attempts,
          stored.reason === 'store_failed',
        );
      }
      if (out.retryable && attempts < deps.retry.attempts) {
        const delays = deps.retry.delaysMs;
        await deps.sleep(delays[Math.min(attempts - 1, delays.length - 1)] ?? 0);
        continue;
      }
      return stop(out.reason, out.code, attempts, out.retryable);
    }
  }
}
