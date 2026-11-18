// The shell's export service (UX-101): the dialog's targets, request, job view and cancel over the
// backend's exports port. The port is a stand-in that reports a job's states through `onProgress`.
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { EXPORT_TARGETS, exportService, jobView } from '../src/export-service.ts';
import type { ExportSource } from '../src/export.ts';

function wireJob(patch: Partial<ExportJob> = {}): ExportJob {
  return {
    id: 'job-1',
    doc: 'doc-1',
    target: 'pdf',
    seq: 4,
    state: 'queued',
    progress: null,
    result: null,
    diagnostics: [],
    createdAt: '2026-11-17T10:00:00Z',
    updatedAt: '2026-11-17T10:00:00Z',
    ...patch,
  };
}

/** A port that reports the given job states, in order, to `onProgress` and then resolves. */
function reportingPort(states: ExportJob[]) {
  const requests: unknown[] = [];
  const cancelled: string[] = [];
  const port: ExportsPort = {
    async request(_docId, body, opts) {
      requests.push(body);
      for (const job of states) opts?.onProgress?.(job);
      return states[0]!;
    },
    async get() {
      throw new Error('not used');
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };
  return { port, requests, cancelled };
}

function sourceOf(port: ExportsPort, access?: ExportSource['access']): ExportSource {
  const backend = { exports: port, features: new Set(['exports']) } as unknown as Backend;
  return { docId: 'doc-1', backend, access: access ?? null };
}

describe('the export service of the element (UX-101)', () => {
  it('offers the PDF and the LaTeX bundle first', () => {
    const service = exportService({ source: () => null });
    expect(service.targets.get()).toEqual(EXPORT_TARGETS);
    expect(EXPORT_TARGETS.slice(0, 2)).toEqual(['pdf', 'tex']);
  });

  it('sends the target and the options of EXP-005 as given, and follows the job to its end', async () => {
    const done = wireJob({
      state: 'completed',
      progress: 100,
      result: {
        url: 'https://files.example/out.pdf',
        expiresAt: '2026-11-17T11:00:00Z',
        pages: 3,
        layout: null,
        converged: true,
      },
      diagnostics: [{ severity: 'warning', code: 'overfull', blockId: 'b-7', message: 'Too wide' }],
    });
    const { port, requests } = reportingPort([
      wireJob(),
      wireJob({ state: 'compiling', progress: 40 }),
      done,
    ]);
    const seen: string[] = [];
    const service = exportService({
      source: () => sourceOf(port),
      onJob: (job) => seen.push(job.state),
    });
    const options = {
      profile: 'final',
      tagging: 'on',
      fields: 'blank',
      pdfStandard: 'ua-2',
      locale: 'en-GB',
      timeZone: 'Europe/London',
    } as const;
    const { jobId } = await service.request('pdf', options);
    expect(jobId).toBe('job-1');
    expect(requests).toEqual([{ target: 'pdf', options }]);
    expect(seen).toEqual(['queued', 'compiling', 'completed']);
    const view = service.job('job-1').get();
    expect(view).toMatchObject({
      state: 'completed',
      progress: 100,
      result: { url: 'https://files.example/out.pdf', pages: 3, converged: true },
      diagnostics: [{ severity: 'warning', blockId: 'b-7', message: 'Too wide' }],
    });
  });

  it('tells a subscriber of each report and stops when it unsubscribes', async () => {
    const { port } = reportingPort([wireJob(), wireJob({ state: 'converting', progress: 10 })]);
    const service = exportService({ source: () => sourceOf(port) });
    const states: Array<string | undefined> = [];
    const view = service.job('job-1');
    const stop = view.subscribe(() => states.push(view.get()?.state));
    await service.request('tex', {});
    stop();
    expect(states).toEqual(['queued', 'converting']);
    expect(service.job('unknown').get()).toBeNull();
  });

  it('cancels through the exports port', async () => {
    const { port, cancelled } = reportingPort([wireJob()]);
    const service = exportService({ source: () => sourceOf(port) });
    await service.cancel('job-1');
    expect(cancelled).toEqual(['job-1']);
  });

  it('refuses without a request under no-export, and without a document', async () => {
    const { port, requests } = reportingPort([wireJob()]);
    const restricted = { restrictions: ['no-export'] } as unknown as ExportSource['access'];
    const service = exportService({ source: () => sourceOf(port, restricted) });
    await expect(service.request('pdf', {})).rejects.toMatchObject({ code: 'forbidden' });
    const none = exportService({ source: () => null });
    await expect(none.request('pdf', {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toEqual([]);
  });

  it('carries a failed job with its error', () => {
    const view = jobView(
      wireJob({ state: 'failed', error: { code: 'internal', message: 'The compile failed' } }),
    );
    expect(view.error).toEqual({ code: 'internal', message: 'The compile failed' });
    expect(view.result).toBeNull();
  });
});
