// printTypesetPdf (FE-073, criteria 1 and 4 in part) and the `no-print` refusal (FE-055, criterion 2
// in part). The exports port is a stand-in that answers with a scripted sequence of job states;
// `printPdf` is a recording function, since the viewer's print path is not built here.
import type { Access, Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { PortError } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { ErrorDetail } from '../src/events.ts';
import { printTypesetPdf, type PrintOptions } from '../src/print.ts';

type Scripted = Record<string, unknown>;

/** An exports port whose `get` returns the scripted jobs in order (the last one repeats). */
function scriptedExports(jobs: Scripted[], requestError?: PortError) {
  const requests: Array<{ docId: string; body: unknown }> = [];
  let polls = 0;
  const port: ExportsPort = {
    async request(docId, body) {
      requests.push({ docId, body });
      if (requestError) throw requestError;
      return { id: 'job-1' } as unknown as ExportJob;
    },
    async get() {
      const job = jobs[Math.min(polls, jobs.length - 1)] ?? {};
      polls += 1;
      return { id: 'job-1', ...job } as never;
    },
    async cancel() {},
  };
  return { port, requests, polls: () => polls };
}

function backendWith(port: ExportsPort | null, announce = true): Backend {
  const features = new Set<string>(announce ? ['exports'] : []);
  return { features, ...(port ? { exports: port } : {}) } as unknown as Backend;
}

function access(restrictions: Access['restrictions'] = []): Access {
  return { restrictions } as unknown as Access;
}

interface Harness {
  options: PrintOptions;
  printed: string[];
  errors: ErrorDetail[];
  waits: number[];
}

function harness(
  backend: Backend | null,
  overrides: Partial<PrintOptions> = {},
  acc: Access | null = access(),
): Harness {
  const printed: string[] = [];
  const errors: ErrorDetail[] = [];
  const waits: number[] = [];
  const options: PrintOptions = {
    source: backend ? { docId: 'doc-1', backend } : null,
    access: acc,
    printPdf: async (url) => {
      printed.push(url);
    },
    onError: (detail) => errors.push(detail),
    pollMs: 7,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  };
  return { options, printed, errors, waits };
}

describe('printTypesetPdf (FE-073)', () => {
  it('polls until the export completes, then prints the signed URL once', async () => {
    const { port, requests, polls } = scriptedExports([
      { state: 'queued', result: null },
      { state: 'compiling', result: null },
      { state: 'completed', result: { url: 'https://signed.example/out.pdf' } },
    ]);
    const h = harness(backendWith(port));
    await expect(printTypesetPdf(h.options)).resolves.toEqual({ status: 'printed' });
    expect(requests).toEqual([{ docId: 'doc-1', body: { target: 'pdf' } }]);
    expect(polls()).toBe(3);
    expect(h.waits).toEqual([7, 7]);
    expect(h.printed).toEqual(['https://signed.example/out.pdf']);
    expect(h.errors).toEqual([]);
  });

  it('reports a failed job as de-error detail and prints nothing', async () => {
    const { port } = scriptedExports([
      { state: 'compiling', result: null },
      {
        state: 'failed',
        result: null,
        error: { code: 'validation_failed', message: 'the compile stopped' },
      },
    ]);
    const h = harness(backendWith(port));
    await expect(printTypesetPdf(h.options)).resolves.toEqual({
      status: 'failed',
      code: 'validation_failed',
      message: 'the compile stopped',
    });
    expect(h.errors).toEqual([
      { code: 'validation_failed', message: 'the compile stopped', fatal: false },
    ]);
    expect(h.printed).toEqual([]);
  });

  it('reports a refused export request with the server code and prints nothing', async () => {
    const { port } = scriptedExports(
      [],
      new PortError('validation_failed', 'target not supported'),
    );
    const h = harness(backendWith(port));
    await expect(printTypesetPdf(h.options)).resolves.toMatchObject({
      status: 'failed',
      code: 'validation_failed',
    });
    expect(h.errors).toHaveLength(1);
    expect(h.printed).toEqual([]);
  });

  it('fails with unsupported_feature when the backend announces no export jobs', async () => {
    const h = harness(backendWith(null, false));
    await expect(printTypesetPdf(h.options)).resolves.toMatchObject({
      status: 'failed',
      code: 'unsupported_feature',
    });
    expect(h.errors[0]?.code).toBe('unsupported_feature');
    expect(h.printed).toEqual([]);
  });

  it('fails with unavailable when no document is loaded', async () => {
    const h = harness(null);
    await expect(printTypesetPdf(h.options)).resolves.toMatchObject({
      status: 'failed',
      code: 'unavailable',
    });
    expect(h.printed).toEqual([]);
  });

  it('reports a failure of the print path itself and does not claim success', async () => {
    const { port } = scriptedExports([{ state: 'completed', result: { url: 'https://x/y.pdf' } }]);
    const h = harness(backendWith(port), {
      printPdf: async () => {
        throw new Error('the viewer did not answer');
      },
    });
    await expect(printTypesetPdf(h.options)).resolves.toMatchObject({
      status: 'failed',
      message: 'the viewer did not answer',
    });
    expect(h.errors).toHaveLength(1);
  });

  it('refuses a completed job without a result as an internal failure', async () => {
    const { port } = scriptedExports([{ state: 'completed', result: null }]);
    const h = harness(backendWith(port));
    await expect(printTypesetPdf(h.options)).resolves.toMatchObject({
      status: 'failed',
      code: 'internal',
    });
    expect(h.printed).toEqual([]);
  });
});

describe('printTypesetPdf refuses no-print (FE-055)', () => {
  it('refuses before any export is requested and before anything is printed', async () => {
    const { port, requests, polls } = scriptedExports([
      { state: 'completed', result: { url: 'https://x/y.pdf' } },
    ]);
    const h = harness(backendWith(port), {}, access(['no-print']));
    await expect(printTypesetPdf(h.options)).resolves.toEqual({
      status: 'refused',
      reason: 'no-print',
    });
    expect(requests).toEqual([]);
    expect(polls()).toBe(0);
    expect(h.printed).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('does not refuse for other restrictions: no-copy does not stop printing', async () => {
    const { port } = scriptedExports([{ state: 'completed', result: { url: 'https://x/a.pdf' } }]);
    const h = harness(backendWith(port), {}, access(['no-copy']));
    await expect(printTypesetPdf(h.options)).resolves.toEqual({ status: 'printed' });
    expect(h.printed).toEqual(['https://x/a.pdf']);
  });
});
