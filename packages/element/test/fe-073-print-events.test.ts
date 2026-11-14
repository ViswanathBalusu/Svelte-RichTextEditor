// FE-073 criterion 4: a failed print export is reported through the export events
// (`de-export-*`) and through `de-error`, in that order, and nothing is printed. Node.js only: the
// exports port is a stand-in (the same shape as print.test.ts). The events are the ones
// `exportEvent` maps each job report to (export.ts).
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { printTypesetPdf, type PrintOptions } from '../src/print.ts';

function portFor(jobs: Array<Record<string, unknown>>): ExportsPort {
  let polls = 0;
  return {
    async request() {
      return { id: 'job-fe-073' } as unknown as ExportJob;
    },
    async get() {
      const job = jobs[Math.min(polls, jobs.length - 1)] ?? {};
      polls += 1;
      return { id: 'job-fe-073', ...job } as never;
    },
    async cancel() {},
  };
}

function options(port: ExportsPort, log: string[], printed: string[]): PrintOptions {
  const backend = { features: new Set(['exports']), exports: port } as unknown as Backend;
  return {
    source: { docId: 'doc-fe-073', backend },
    access: null,
    printPdf: async (url) => {
      printed.push(url);
    },
    onError: (detail) => log.push(`error:${detail.code}`),
    onExportEvent: (event) => log.push(`event:${event.name}:${event.detail.state}`),
    pollMs: 1,
    wait: async () => {},
  };
}

describe('printTypesetPdf export events (FE-073, criterion 4)', () => {
  it('raises de-export-failed for the failed job, then de-error, and prints nothing', async () => {
    const log: string[] = [];
    const printed: string[] = [];
    const port = portFor([
      { state: 'compiling', progress: 0.5, result: null },
      {
        state: 'failed',
        progress: 0.5,
        result: null,
        error: { code: 'validation_failed', message: 'the compile stopped' },
      },
    ]);
    await expect(printTypesetPdf(options(port, log, printed))).resolves.toMatchObject({
      status: 'failed',
      code: 'validation_failed',
    });
    expect(log).toEqual([
      'event:de-export-progress:compiling',
      'event:de-export-failed:failed',
      'error:validation_failed',
    ]);
    expect(printed).toEqual([]);
  });

  it('raises de-export-failed for a cancelled job and reports it as de-error', async () => {
    const log: string[] = [];
    const printed: string[] = [];
    const port = portFor([{ state: 'cancelled', progress: null, result: null }]);
    await expect(printTypesetPdf(options(port, log, printed))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(log).toEqual(['event:de-export-failed:cancelled', 'error:internal']);
    expect(printed).toEqual([]);
  });

  it('raises de-export-completed for a completed job and prints its signed URL once', async () => {
    const log: string[] = [];
    const printed: string[] = [];
    const port = portFor([
      { state: 'queued', progress: null, result: null },
      { state: 'completed', progress: 1, result: { url: 'https://signed.example/out.pdf' } },
    ]);
    await expect(printTypesetPdf(options(port, log, printed))).resolves.toEqual({
      status: 'printed',
    });
    expect(log).toEqual(['event:de-export-progress:queued', 'event:de-export-completed:completed']);
    expect(printed).toEqual(['https://signed.example/out.pdf']);
  });
});
