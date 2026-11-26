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
 * `latestPdf` is the newest job of target `pdf` this service started, whoever asked for it (the
 * dialog or the PDF pane); the shell's PDF pane shows it (EXP-001).
 *
 * Open (docs/adr/0388-w3-UX-101-export-targets.md): the protocol has no way for a deployment to
 * announce its export targets, so `EXPORT_TARGETS` is a fixed list. The service refuses a target it
 * does not support with `validation_failed`, and the dialog then says the export did not start.
 *
 * No DOM: this runs in Node.js tests against a stand-in exports port.
 */
import type { ExportJob } from '@docedit/protocol';
import type {
  ExportDiagnostic,
  ExportJobView,
  ExportOptions,
  ExportService,
  ExportTarget,
} from '@docedit/ui';
import { startExport, type ExportRequest, type ExportSource } from './export.ts';

/** The targets the dialog offers, in order: the PDF and the LaTeX bundle first (UX-101). */
export const EXPORT_TARGETS: readonly ExportTarget[] = ['pdf', 'tex'];

/** Every target the dialog has a name for (`export.target.<id>` in the shell's strings). */
const KNOWN_TARGETS: readonly ExportTarget[] = ['pdf', 'tex', 'docx', 'cdm', 'html', 'md'];

/**
 * The targets the dialog offers for what a deployment announced (`exportTargets` of the discovery
 * document, 05 §2): the PDF and the LaTeX bundle first when they are announced, then the others in
 * the order announced. A name the dialog has no string for is left out. When the deployment does
 * not say (null), the fixed list stands (ADR 0382).
 */
export function announcedTargets(
  announced: readonly string[] | null | undefined,
): readonly ExportTarget[] {
  if (!announced) return EXPORT_TARGETS;
  const known = (id: string): id is ExportTarget =>
    (KNOWN_TARGETS as readonly string[]).includes(id);
  const listed = announced.filter(known);
  return [
    ...EXPORT_TARGETS.filter((t) => listed.includes(t)),
    ...listed.filter((t) => !EXPORT_TARGETS.includes(t)),
  ];
}

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
  /** The targets to offer; absent, those the backend announced, or `EXPORT_TARGETS`. */
  targets?: readonly ExportTarget[];
  /**
   * The preflight shared with the converter (EXP-003; `export-preflight.ts`), run on the document
   * the editor holds before a job is created. Absent: the dialog creates the job at once.
   */
  preflight?: (
    target: ExportTarget,
    options: ExportOptions,
  ) => Promise<readonly ExportDiagnostic[]>;
  /**
   * Whether the export will leave out parts hidden from this reader (ADR 0019; UX-104): true when
   * the document the editor holds has a placeholder for a hidden region. Absent: the dialog says
   * nothing.
   */
  projected?: () => boolean;
}

/** True when the body of a document holds a placeholder for a region hidden from the reader. */
export function hasHiddenRegion(content: { readonly doc?: unknown }): boolean {
  const doc = content.doc as
    { readonly content?: readonly { readonly content?: readonly unknown[] }[] } | undefined;
  const top = doc?.content;
  const body = top?.[top.length - 1];
  return (body?.content ?? []).some(
    (node) => (node as { type?: unknown } | null)?.type === 'hidden_region',
  );
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
  // The deployment's own list, read from the backend when the dialog asks: discovery
  // is read at connect, before the editor is shown, and the list is the same until it reconnects.
  // The same array is returned while the announced list is the same, so a reader sees no change.
  let lastKey = '\0';
  let last: readonly ExportTarget[] = EXPORT_TARGETS;
  const targetsNow = (): readonly ExportTarget[] => {
    if (options.targets) return options.targets;
    const announced = options.source()?.backend?.exportTargets?.() ?? null;
    const key = announced ? announced.join(',') : '\0';
    if (key !== lastKey) {
      lastKey = key;
      last = announcedTargets(announced);
    }
    return last;
  };

  // The newest PDF job this service started (EXP-001): the PDF pane shows it. "Newest" is by the
  // order the jobs were first reported in, so a late report of an older job does not replace it.
  let pdfJobs = 0;
  const pdfOrder = new Map<string, number>();
  let latestPdf: ExportJobView | null = null;
  const pdfListeners = new Set<() => void>();
  const followPdf = (view: ExportJobView): void => {
    if (view.target !== 'pdf') return;
    let order = pdfOrder.get(view.id);
    if (order === undefined) pdfOrder.set(view.id, (order = ++pdfJobs));
    if (latestPdf !== null && order < (pdfOrder.get(latestPdf.id) ?? 0)) return;
    latestPdf = view;
    for (const listener of [...pdfListeners]) listener();
  };

  const check = options.preflight;
  const projected = options.projected;
  return {
    targets: { get: targetsNow, subscribe: () => () => {} },
    // The dialog says that hidden parts are left out when this is true (ADR 0019; UX-104).
    ...(projected ? { projected: { get: projected, subscribe: () => () => {} } } : {}),
    // The dialog asks before it creates a job, and only when the element can run the check.
    ...(check
      ? { preflight: (target: ExportTarget, given?: ExportOptions) => check(target, given ?? {}) }
      : {}),
    latestPdf: {
      get: () => latestPdf,
      subscribe(listener) {
        pdfListeners.add(listener);
        return () => pdfListeners.delete(listener);
      },
    },
    async request(target: ExportTarget, given: ExportOptions): Promise<{ jobId: string }> {
      // The options the dialog passes are the wire options; nothing is added or renamed here.
      const body: ExportRequest = { target, options: { ...given } };
      return startExport(options.source(), body, (job) => {
        const e = entry(job.id);
        e.view = jobView(job);
        for (const listener of [...e.listeners]) listener();
        followPdf(e.view);
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
