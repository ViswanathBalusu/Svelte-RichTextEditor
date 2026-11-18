/**
 * The shell's export service over the backend's exports port (UX-101; PRO-086). The export dialog
 * reads `targets`, starts a job with `request`, follows it through `job(id)` and stops it with
 * `cancel`. A job's reports come from the port's `onProgress` (polling, PRO-096); each report
 * updates the job's view and goes to `onJob`, so the element raises the same `de-export-*` events
 * as `requestExport` does.
 *
 * `startExport` does the checks of PRO-086: no document, no exports port, no `exports` feature, and
 * the `no-export` restriction each refuse before any request is sent.
 *
 * Open (docs/adr/0388-w3-UX-101-export-targets.md): the protocol has no way for a deployment to
 * announce its export targets, so `EXPORT_TARGETS` is a fixed list. The service refuses a target it
 * does not support with `validation_failed`, and the dialog then says the export did not start.
 *
 * No DOM: this runs in Node.js tests against a stand-in exports port.
 */
import type { ExportJob } from '@docedit/protocol';
import type { ExportJobView, ExportOptions, ExportService, ExportTarget } from '@docedit/ui';
import { startExport, type ExportRequest, type ExportSource } from './export.ts';

/** The targets the dialog offers, in order: the PDF and the LaTeX bundle first (UX-101). */
export const EXPORT_TARGETS: readonly ExportTarget[] = ['pdf', 'tex'];

/** What the dialog needs of a job report (the wire job carries more). */
export function jobView(job: ExportJob): ExportJobView {
  return {
    id: job.id,
    target: job.target,
    seq: job.seq,
    state: job.state,
    progress: job.progress,
    result: job.result
      ? { url: job.result.url, pages: job.result.pages, converged: job.result.converged }
      : null,
    diagnostics: job.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      blockId: d.blockId,
      message: d.message,
    })),
    ...(job.error ? { error: { code: job.error.code, message: job.error.message } } : {}),
  };
}

interface Entry {
  view: ExportJobView | null;
  readonly listeners: Set<() => void>;
}

export interface ExportServiceOptions {
  /** The session now: its document, backend and access; null when none is loaded. */
  source: () => ExportSource | null;
  /** Called with every report of every job this service started. */
  onJob?: (job: ExportJob) => void;
  /** The targets to offer; absent, `EXPORT_TARGETS`. */
  targets?: readonly ExportTarget[];
}

/** The export service of one editor; the element builds it when the backend has an exports port. */
export function exportService(options: ExportServiceOptions): ExportService {
  const entries = new Map<string, Entry>();
  const entry = (id: string): Entry => {
    let e = entries.get(id);
    if (!e) {
      e = { view: null, listeners: new Set() };
      entries.set(id, e);
    }
    return e;
  };
  const targets = options.targets ?? EXPORT_TARGETS;

  return {
    targets: { get: () => targets, subscribe: () => () => {} },
    async request(target: ExportTarget, given: ExportOptions): Promise<{ jobId: string }> {
      // The options the dialog passes are the wire options; nothing is added or renamed here.
      const body: ExportRequest = { target, options: { ...given } };
      return startExport(options.source(), body, (job) => {
        const e = entry(job.id);
        e.view = jobView(job);
        for (const listener of [...e.listeners]) listener();
        options.onJob?.(job);
      });
    },
    job(jobId) {
      const e = entry(jobId);
      return {
        get: () => e.view,
        subscribe(listener) {
          e.listeners.add(listener);
          return () => e.listeners.delete(listener);
        },
      };
    },
    async cancel(jobId: string): Promise<void> {
      const backend = options.source()?.backend;
      await backend?.exports?.cancel(jobId);
    },
  };
}
