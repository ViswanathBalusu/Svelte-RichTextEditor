// EXP-001: the export service follows the newest PDF job it started, for the shell's PDF pane.
// The exports port is a stand-in whose reports the test sends by hand, in the order it chooses.
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { exportService } from '../src/export-service.ts';

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
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    ...patch,
  };
}

const done = (id: string, url: string): ExportJob =>
  wireJob({
    id,
    state: 'completed',
    progress: 100,
    result: {
      url,
      expiresAt: '2026-11-20T11:00:00Z',
      pages: 2,
      layout: null,
      converged: false,
    },
  });

/** A port that gives each request the next identifier and keeps its `onProgress` for the test. */
function heldPort() {
  const reports = new Map<string, (job: ExportJob) => void>();
  let n = 0;
  const port: ExportsPort = {
    async request(_docId, body, opts) {
      const id = `job-${++n}`;
      const first = wireJob({ id, target: (body as { target: ExportJob['target'] }).target });
      if (opts?.onProgress) {
        reports.set(id, opts.onProgress);
        opts.onProgress(first);
      }
      return first;
    },
    async get() {
      throw new Error('not used');
    },
    async cancel() {},
  };
  return { port, report: (job: ExportJob) => reports.get(job.id)!(job) };
}

function serviceOver(port: ExportsPort) {
  const backend = { exports: port, features: new Set(['exports']) } as unknown as Backend;
  return exportService({ source: () => ({ docId: 'doc-1', backend, access: null }) });
}

describe('EXP-001 the newest PDF job of the session', () => {
  it('is null before any PDF is asked for, and the job once one is', async () => {
    const { port } = heldPort();
    const service = serviceOver(port);
    expect(service.latestPdf?.get()).toBeNull();
    await service.request('pdf', { profile: 'preview' });
    expect(service.latestPdf?.get()).toMatchObject({ id: 'job-1', target: 'pdf', state: 'queued' });
  });

  it('follows each report of that job, and tells its subscribers', async () => {
    const { port, report } = heldPort();
    const service = serviceOver(port);
    const seen: Array<string | undefined> = [];
    const stop = service.latestPdf!.subscribe(() => seen.push(service.latestPdf!.get()?.state));
    await service.request('pdf', {});
    report(wireJob({ state: 'compiling', progress: 40 }));
    report(done('job-1', 'https://files.example/one.pdf'));
    expect(seen).toEqual(['queued', 'compiling', 'completed']);
    expect(service.latestPdf!.get()).toMatchObject({
      state: 'completed',
      result: { url: 'https://files.example/one.pdf', pages: 2, converged: false },
    });
    stop();
    report(done('job-1', 'https://files.example/again.pdf'));
    expect(seen).toHaveLength(3);
  });

  it('ignores jobs of other targets', async () => {
    const { port, report } = heldPort();
    const service = serviceOver(port);
    await service.request('tex', {});
    expect(service.latestPdf!.get()).toBeNull();
    await service.request('pdf', {});
    await service.request('docx', {});
    report(wireJob({ id: 'job-3', target: 'docx', state: 'completed', progress: 100 }));
    expect(service.latestPdf!.get()).toMatchObject({ id: 'job-2', state: 'queued' });
  });

  it('moves to a newer PDF job, and a late report of the older one does not take it back', async () => {
    const { port, report } = heldPort();
    const service = serviceOver(port);
    await service.request('pdf', {});
    await service.request('pdf', { profile: 'preview' });
    expect(service.latestPdf!.get()).toMatchObject({ id: 'job-2', state: 'queued' });
    report(done('job-1', 'https://files.example/one.pdf'));
    expect(service.latestPdf!.get()).toMatchObject({ id: 'job-2', state: 'queued' });
    report(done('job-2', 'https://files.example/two.pdf'));
    expect(service.latestPdf!.get()).toMatchObject({
      id: 'job-2',
      result: { url: 'https://files.example/two.pdf' },
    });
    // The older job is still followed under its own identifier, as the dialog reads it.
    expect(service.job('job-1').get()).toMatchObject({ state: 'completed' });
  });
});
