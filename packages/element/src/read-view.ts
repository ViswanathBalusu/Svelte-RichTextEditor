/**
 * The read view on the typeset PDF (02 §7; FE-072). `view="read"` shows the pages of the typeset
 * PDF, read-only, with no editing surface. This module runs the part that does not need a DOM:
 * it starts a PDF export of the loaded document (through `startExport`, the route of PRO-063),
 * reports the job's progress while the export runs, opens the signed URL in the viewer once the
 * export is complete, and returns the diagnostics of the job with their block identifiers so that
 * the shell can point each one back to a document location.
 *
 * What is not here (FE-072 Notes): the mounting of the read view in place of the editing surface,
 * the rendering of the progress and of the diagnostics list, and moving the editor to a block
 * (that needs the editing core and the web view). The viewer is injected as `openPdf`, so the
 * function runs in Node.js tests.
 *
 * Failures are returned, not thrown: a refused start or a failed export gives `status: 'failed'`
 * (or `'unavailable'` when no export could be started), with the registry code and a message.
 */
import type { ErrorCode } from '@docedit/protocol';
import { codeOf, messageOf } from './errors.ts';
import { startExport, type ExportSource } from './export.ts';

/** Time between two polls of the export job, in milliseconds. A provisional default (as PRINT_POLL_MS). */
export const READ_VIEW_POLL_MS = 1_000;

/** The interface strings of the read view. Replaceable strings are UX's (13 §8). */
export const READ_VIEW_STRINGS = {
  /** Shown on the read view in place of an editing surface (FE-072 criterion 5). */
  label: 'Typeset result, not an editing view',
  /** Shown while the export runs. */
  exporting: 'Preparing the typeset PDF',
  /** Shown for a failed export; the diagnostics follow it. */
  failed: 'The typeset PDF could not be made',
} as const;

/** One diagnostic of the export job (09 §9.2), with the block it points at, when it has one. */
export interface ReadViewDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  /** The block to move the editor to, when the user may edit it (FE-072 criterion 4); else null. */
  readonly blockId: string | null;
}

/** The job's state while it runs, as the poll sees it. `percent` is null while the worker does not say. */
export interface ReadViewProgress {
  readonly state: string;
  readonly percent: number | null;
}

export type ReadViewOutcome =
  | {
      readonly status: 'shown';
      readonly url: string;
      readonly pages: number | null;
      readonly diagnostics: readonly ReadViewDiagnostic[];
    }
  | {
      readonly status: 'failed';
      readonly code: ErrorCode;
      readonly message: string;
      readonly diagnostics: readonly ReadViewDiagnostic[];
    }
  | { readonly status: 'unavailable'; readonly code: ErrorCode; readonly message: string };

export interface ReadViewOptions {
  /** The loaded document and its backend, as for `requestExport`. */
  readonly source: ExportSource | null;
  /** Opens the signed URL of the typeset PDF in the viewer. Called once, after a completed export. */
  readonly openPdf: (url: string) => Promise<void>;
  /** Receives the progress of each poll while the export runs (FE-072 criterion 2). */
  readonly onProgress?: (progress: ReadViewProgress) => void;
  /**
   * Receives the diagnostics once the job is complete or has failed, before the PDF is opened, so
   * that they are listed even when the viewer then fails (FE-072 criterion 3).
   */
  readonly onDiagnostics?: (diagnostics: readonly ReadViewDiagnostic[]) => void;
  /** Milliseconds between polls; defaults to `READ_VIEW_POLL_MS`. */
  readonly pollMs?: number;
  /** Waits between polls; tests replace it. */
  readonly wait?: (ms: number) => Promise<void>;
}

/** The part of an export job this module reads (the server's `ExportJob`, 09 §9.1). */
interface JobView {
  readonly state: string;
  readonly progress?: number | null;
  readonly result: { readonly url: string; readonly pages?: number | null } | null;
  readonly diagnostics?: ReadonlyArray<{
    readonly severity: string;
    readonly code: string;
    readonly message: string;
    readonly blockId?: string | null;
  }>;
  readonly error?: { readonly code: string; readonly message: string };
}

const TERMINAL_FAILURE = new Set(['failed', 'cancelled']);

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The diagnostics of a job, copied into the read view's shape (FE-072 criterion 3). */
export function readViewDiagnostics(job: JobView): ReadViewDiagnostic[] {
  return (job.diagnostics ?? []).map((d) => ({
    severity: d.severity,
    code: d.code,
    message: d.message,
    blockId: d.blockId ?? null,
  }));
}

/** Runs the PDF export for the read view and opens the result; never throws. */
export async function openReadView(options: ReadViewOptions): Promise<ReadViewOutcome> {
  let jobId: string;
  try {
    jobId = (await startExport(options.source, { target: 'pdf' })).jobId;
  } catch (e) {
    return { status: 'unavailable', code: codeOf(e), message: messageOf(e) };
  }

  const backend = options.source?.backend;
  const exports = backend?.exports;
  if (!exports)
    return { status: 'unavailable', code: 'unsupported_feature', message: 'no exports port' };

  const wait = options.wait ?? defaultWait;
  const pollMs = options.pollMs ?? READ_VIEW_POLL_MS;
  for (;;) {
    let job: JobView;
    try {
      job = (await exports.get(jobId)) as unknown as JobView;
    } catch (e) {
      return { status: 'failed', code: codeOf(e), message: messageOf(e), diagnostics: [] };
    }
    const diagnostics = readViewDiagnostics(job);
    if (job.state === 'completed' || TERMINAL_FAILURE.has(job.state))
      options.onDiagnostics?.(diagnostics);
    if (job.state === 'completed') {
      if (!job.result)
        return {
          status: 'failed',
          code: 'internal',
          message: 'the export completed without a result',
          diagnostics,
        };
      try {
        await options.openPdf(job.result.url);
      } catch (e) {
        return { status: 'failed', code: codeOf(e), message: messageOf(e), diagnostics };
      }
      return {
        status: 'shown',
        url: job.result.url,
        pages: job.result.pages ?? null,
        diagnostics,
      };
    }
    if (TERMINAL_FAILURE.has(job.state)) {
      return {
        status: 'failed',
        code: job.error ? codeOf(job.error) : 'internal',
        message: job.error?.message ?? 'the export did not complete',
        diagnostics,
      };
    }
    options.onProgress?.({ state: job.state, percent: job.progress ?? null });
    await wait(pollMs);
  }
}
