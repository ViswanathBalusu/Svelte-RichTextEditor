/**
 * Printing the typeset PDF (02 §9.8; FE-073) and the refusal of `no-print` (FE-055).
 *
 * The element never prints painted pages or its shadow DOM (02 §9.8). Printing asks the backend
 * for a typeset PDF, waits for the export job to finish, and hands the signed URL to `printPdf`,
 * which the caller supplies (the viewer's print path; not built yet, so it is an injected function
 * here). The job is the server's (PRO-063); this module only polls it.
 *
 * - A person whose access lists `no-print` is refused before any export is requested and before
 *   `printPdf` runs, so nothing is printed (FE-055). The refusal is returned to the caller, which
 *   decides what the shell shows (UX-040).
 * - A failed export (or a refused request) is reported through `onError` as `de-error` detail and
 *   nothing is printed (FE-073).
 *
 * No DOM and no `window`: the function runs in Node.js tests against a stand-in exports port.
 */
import type { Access, ErrorCode, ExportJob } from '@docedit/protocol';
import { hasPort } from '@docedit/protocol';
import type { ErrorDetail } from './events.ts';
import { codeOf, messageOf } from './errors.ts';
import { exportEvent, startExport, type ExportRequest, type ExportSource } from './export.ts';

/**
 * Time between two polls of an export job, in milliseconds. A provisional default, not a
 * measurement; the job's progress stream does not exist yet (PRO-086), so the element polls.
 */
export const PRINT_POLL_MS = 1_000;

/** The part of an export job this module reads (the server's `ExportJob`, 09 §9.2). */
interface JobView {
  readonly id: string;
  readonly state: string;
  readonly progress?: number | null;
  readonly result: { readonly url: string } | null;
  readonly error?: { readonly code: string; readonly message: string };
}

export type PrintOutcome =
  | { readonly status: 'printed' }
  | { readonly status: 'refused'; readonly reason: 'no-print' }
  | { readonly status: 'failed'; readonly code: ErrorCode; readonly message: string };

export interface PrintOptions {
  /** The loaded document and its backend, as for `requestExport`. */
  readonly source: ExportSource | null;
  /** The access in force now; `restrictions` is read at the moment of the call. */
  readonly access: Access | null;
  /** Prints the PDF at a signed URL, through the viewer. Called once, only after a successful export. */
  readonly printPdf: (url: string) => Promise<void>;
  /** Receives the failure as `de-error` detail. Nothing else is raised here. */
  readonly onError: (detail: ErrorDetail) => void;
  /** Milliseconds between polls; defaults to `PRINT_POLL_MS`. */
  readonly pollMs?: number;
  /** Waits between polls; tests replace it. */
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * Receives the `de-export-*` event of each job report (FE-073 criterion 4), before the job's
   * outcome is acted on, so a failed job raises `de-export-failed` and then `de-error`.
   */
  readonly onExportEvent?: (event: PrintExportEvent) => void;
}

/** The export event a job report raises (`exportEvent`, export.ts). */
export type PrintExportEvent = ReturnType<typeof exportEvent>;

const TERMINAL_FAILURE = new Set(['failed', 'cancelled']);

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Refuses without side effects when the access lists `no-print`; otherwise runs the export. */
export async function printTypesetPdf(options: PrintOptions): Promise<PrintOutcome> {
  if (options.access?.restrictions.includes('no-print'))
    return { status: 'refused', reason: 'no-print' };

  const fail = (code: ErrorCode, message: string): PrintOutcome => {
    options.onError({ code, message, fatal: false });
    return { status: 'failed', code, message };
  };

  let jobId: string;
  try {
    const request = { target: 'pdf' } as ExportRequest;
    jobId = (await startExport(options.source, request)).jobId;
  } catch (e) {
    return fail(codeOf(e), messageOf(e));
  }

  const backend = options.source?.backend;
  if (!backend || !hasPort(backend, 'exports') || !backend.exports)
    return fail('unsupported_feature', 'the backend announces no export jobs');
  const exports = backend.exports;

  const wait = options.wait ?? defaultWait;
  const pollMs = options.pollMs ?? PRINT_POLL_MS;
  for (;;) {
    let job: JobView;
    try {
      job = (await exports.get(jobId)) as unknown as JobView;
    } catch (e) {
      return fail(codeOf(e), messageOf(e));
    }
    options.onExportEvent?.(
      exportEvent({
        id: job.id,
        state: job.state,
        progress: job.progress ?? null,
      } as unknown as ExportJob),
    );
    if (job.state === 'completed') {
      if (!job.result) return fail('internal', 'the export completed without a result');
      try {
        await options.printPdf(job.result.url);
      } catch (e) {
        return fail(codeOf(e), messageOf(e));
      }
      return { status: 'printed' };
    }
    if (TERMINAL_FAILURE.has(job.state)) {
      const code = job.error ? codeOf(job.error) : 'internal';
      const message = job.error?.message ?? 'the export did not complete';
      return fail(code, message);
    }
    await wait(pollMs);
  }
}
