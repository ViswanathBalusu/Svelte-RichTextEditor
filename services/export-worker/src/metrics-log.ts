/**
 * How the worker's consumers read an attempt's metrics (EXP-060 criterion 2; EXP-064 criterion 6;
 * ADR 0045). The handler reports every attempt, failed and aborted ones included, so the log line
 * names the outcome and a latency summary takes completed attempts only: a failed attempt's stages
 * that did not run are 0 and would pull the medians down. The same holds for a preview that showed
 * an earlier preview's files and compiled nothing (EXP-008 criterion 3): the log line says so, and
 * the summary leaves it out.
 */
import type { JobRecord, LogFields } from '@docedit/document-service';
import type { ExportAttemptState, ExportMetrics } from './job.ts';

/** The log event of an attempt that ended in each state. */
export const METRICS_EVENTS: Readonly<Record<ExportAttemptState, string>> = {
  completed: 'export.completed',
  failed: 'export.attempt_failed',
  aborted: 'export.attempt_aborted',
};

/** Targets the log names; any other value (a refused one) is logged as `other`. */
const KNOWN_TARGETS: ReadonlySet<string> = new Set(['pdf', 'tex', 'cdm']);

/** The log line of one attempt's metrics. Numbers only (BE-088): no value from the document. */
export function metricsLogFields(m: ExportMetrics, job: JobRecord): LogFields {
  return {
    event: METRICS_EVENTS[m.state],
    tenant: job.tenant,
    ...(job.doc ? { doc: job.doc } : {}),
    job: job.id,
    durationMs: m.totalMs,
    message: `target ${KNOWN_TARGETS.has(m.target) ? m.target : 'other'}; queue ${m.queueWaitMs} ms; content ${m.contentMs} ms; convert ${m.convertMs} ms; sandbox ${m.sandboxMs} ms (passes ${m.passMs.join('+')} ms); store ${m.storeMs} ms; log ${m.logBytes} B; pdf ${m.pdfBytes ?? 0} B; ${m.pages ?? 0} pages${m.reused ? '; no compile, an earlier preview of the same bundle is shown' : ''}`,
  };
}

/**
 * The metrics a latency summary may take: those of completed attempts that compiled, or that had
 * no compile to make (the `tex` and `cdm` targets). A preview that showed earlier files is left out.
 */
export function completedMetrics(ms: Iterable<ExportMetrics | null | undefined>): ExportMetrics[] {
  const out: ExportMetrics[] = [];
  for (const m of ms) if (m && m.state === 'completed' && !m.reused) out.push(m);
  return out;
}
