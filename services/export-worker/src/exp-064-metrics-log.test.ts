/**
 * EXP-064 criterion 6, the consumers: the worker's log line (main.ts) names how each attempt ended,
 * and the latency summary (scripts/latency.ts) takes its medians from completed attempts only.
 */
import { createLogger, type JobRecord } from '@docedit/document-service';
import { describe, expect, it } from 'vitest';
import type { ExportMetrics } from './job.ts';
import { completedMetrics, metricsLogFields } from './metrics-log.ts';

const job = { id: 'job-1', tenant: 'tenant-1', doc: 'doc-1' } as JobRecord;

const metrics = (over: Partial<ExportMetrics> = {}): ExportMetrics => ({
  state: 'completed',
  target: 'pdf',
  queueWaitMs: 5,
  contentMs: 10,
  convertMs: 20,
  verifyMs: 3,
  sandboxMs: 900,
  passMs: [400, 400],
  sandboxOverheadMs: 100,
  parseMs: 4,
  storeMs: 6,
  totalMs: 950,
  logBytes: 1234,
  pdfBytes: 5678,
  pages: 2,
  ...over,
});

describe('EXP-064 criterion 6: the consumers of attempt metrics', () => {
  it.each([
    ['completed', 'export.completed'],
    ['failed', 'export.attempt_failed'],
    ['aborted', 'export.attempt_aborted'],
  ] as const)('logs a %s attempt as %s, with its log size', (state, event) => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).info(metricsLogFields(metrics({ state }), job));
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      event,
      tenant: 'tenant-1',
      doc: 'doc-1',
      job: 'job-1',
      durationMs: 950,
    });
    expect(line['message']).toContain('log 1234 B');
    expect(line['message']).toContain('target pdf');
  });

  it('never logs a failed attempt as export.completed', () => {
    expect(metricsLogFields(metrics({ state: 'failed', sandboxMs: 0 }), job).event).not.toBe(
      'export.completed',
    );
  });

  it('logs a target it does not know as other, not the value of the job', () => {
    const fields = metricsLogFields(metrics({ state: 'failed', target: '<script>' }), job);
    expect(fields.message).toContain('target other');
    expect(fields.message).not.toContain('<script>');
  });

  it('keeps only completed attempts for the latency medians', () => {
    const done = metrics();
    const failed = metrics({
      state: 'failed',
      contentMs: 0,
      convertMs: 0,
      sandboxMs: 0,
      passMs: [],
    });
    const aborted = metrics({ state: 'aborted' });
    expect(completedMetrics([done, failed, null, aborted, undefined])).toEqual([done]);
  });
});
