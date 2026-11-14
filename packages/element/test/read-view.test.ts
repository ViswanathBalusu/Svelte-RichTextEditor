// openReadView (FE-072, criteria 2 to 4 in part): the read view's export, its progress and its
// diagnostics, run against a scripted exports port. The viewer is a recording function, since the
// DOM part (the frame and the read-only surface) is not built in Node.js tests.
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { PortError } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { openReadView, READ_VIEW_STRINGS, type ReadViewOptions } from '../src/read-view.ts';

type Scripted = Record<string, unknown>;

/** An exports port whose `get` answers the scripted jobs in order; the last one repeats. */
function scriptedExports(jobs: Scripted[], requestError?: PortError) {
  let polls = 0;
  const requests: unknown[] = [];
  const port: ExportsPort = {
    async request(docId, body) {
      requests.push({ docId, body });
      if (requestError) throw requestError;
      return { id: 'job-1' } as unknown as ExportJob;
    },
    async get() {
      const job = jobs[Math.min(polls, jobs.length - 1)] ?? {};
      polls += 1;
      return { id: 'job-1', diagnostics: [], ...job } as never;
    },
    async cancel() {},
  };
  return { port, requests, polls: () => polls };
}

function backendWith(port: ExportsPort | null): Backend {
  return {
    features: new Set<string>(['exports']),
    ...(port ? { exports: port } : {}),
  } as unknown as Backend;
}

function harness(port: ExportsPort | null, overrides: Partial<ReadViewOptions> = {}) {
  const opened: string[] = [];
  const progress: Array<{ state: string; percent: number | null }> = [];
  const waits: number[] = [];
  const options: ReadViewOptions = {
    source: port ? { docId: 'doc-1', backend: backendWith(port) } : null,
    openPdf: async (url) => {
      opened.push(url);
    },
    onProgress: (p) => progress.push(p),
    pollMs: 5,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  };
  return { options, opened, progress, waits };
}

describe('openReadView (FE-072)', () => {
  it('reports progress while the export runs, then opens the signed URL once', async () => {
    const { port, requests } = scriptedExports([
      { state: 'queued', progress: null, result: null },
      { state: 'converting', progress: 40, result: null },
      {
        state: 'completed',
        progress: 100,
        result: { url: 'https://signed.example/out.pdf', pages: 12 },
      },
    ]);
    const h = harness(port);
    const outcome = await openReadView(h.options);
    expect(outcome).toEqual({
      status: 'shown',
      url: 'https://signed.example/out.pdf',
      pages: 12,
      diagnostics: [],
    });
    expect(h.opened).toEqual(['https://signed.example/out.pdf']);
    expect(h.progress).toEqual([
      { state: 'queued', percent: null },
      { state: 'converting', percent: 40 },
    ]);
    expect(h.waits).toEqual([5, 5]);
    expect(requests).toEqual([{ docId: 'doc-1', body: { target: 'pdf' } }]);
  });

  it('lists the diagnostics of a failed export, each with its block when it has one', async () => {
    const { port } = scriptedExports([
      {
        state: 'failed',
        error: { code: 'internal', message: 'compile failed' },
        diagnostics: [
          { severity: 'error', code: 'E1', message: 'unknown style', blockId: 'b-7' },
          { severity: 'warning', code: 'W2', message: 'image skipped', blockId: null },
        ],
      },
    ]);
    const h = harness(port);
    const outcome = await openReadView(h.options);
    expect(outcome).toEqual({
      status: 'failed',
      code: 'internal',
      message: 'compile failed',
      diagnostics: [
        { severity: 'error', code: 'E1', message: 'unknown style', blockId: 'b-7' },
        { severity: 'warning', code: 'W2', message: 'image skipped', blockId: null },
      ],
    });
    expect(h.opened).toEqual([]);
  });

  it('reports a cancelled export as failed without opening anything', async () => {
    const { port } = scriptedExports([{ state: 'cancelled', result: null }]);
    const h = harness(port);
    const outcome = await openReadView(h.options);
    expect(outcome).toMatchObject({
      status: 'failed',
      code: 'internal',
      message: 'the export did not complete',
    });
    expect(h.opened).toEqual([]);
  });

  it('refuses without an export when no document is loaded', async () => {
    const h = harness(null);
    await expect(openReadView(h.options)).resolves.toMatchObject({
      status: 'unavailable',
      code: 'unavailable',
    });
  });

  it('refuses when the backend announces no exports port', async () => {
    const h = harness(null, {
      source: { docId: 'doc-1', backend: backendWith(null) },
    });
    await expect(openReadView(h.options)).resolves.toMatchObject({
      status: 'unavailable',
      code: 'unsupported_feature',
    });
  });

  it('passes a refused start through with its registry code', async () => {
    const { port } = scriptedExports([], new PortError('forbidden', 'no export'));
    const h = harness(port);
    await expect(openReadView(h.options)).resolves.toEqual({
      status: 'unavailable',
      code: 'forbidden',
      message: 'no export',
    });
  });

  it('reports a failure of the viewer as failed, with the diagnostics it had', async () => {
    const { port } = scriptedExports([
      {
        state: 'completed',
        result: { url: 'https://signed.example/out.pdf', pages: 1 },
        diagnostics: [{ severity: 'warning', code: 'W', message: 'm', blockId: 'b-1' }],
      },
    ]);
    const h = harness(port, {
      openPdf: async () => {
        throw new PortError('unavailable', 'the PDF viewer did not answer');
      },
    });
    await expect(openReadView(h.options)).resolves.toEqual({
      status: 'failed',
      code: 'unavailable',
      message: 'the PDF viewer did not answer',
      diagnostics: [{ severity: 'warning', code: 'W', message: 'm', blockId: 'b-1' }],
    });
  });

  it('fails when a completed export has no result', async () => {
    const { port } = scriptedExports([{ state: 'completed', result: null }]);
    const h = harness(port);
    await expect(openReadView(h.options)).resolves.toMatchObject({
      status: 'failed',
      code: 'internal',
    });
    expect(h.opened).toEqual([]);
  });

  it('labels the read view as the typeset result, not as an editing view', () => {
    expect(READ_VIEW_STRINGS.label).toMatch(/typeset result/i);
    expect(READ_VIEW_STRINGS.label).toMatch(/not an editing view/i);
  });

  it('opens the PDF exactly once, after as many progress reports as non-final polls (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('queued', 'converting', 'compiling'), { maxLength: 12 }),
        async (stages) => {
          const jobs: Scripted[] = [
            ...stages.map((state) => ({ state, progress: null, result: null })),
            { state: 'completed', result: { url: 'https://signed.example/x.pdf', pages: 3 } },
          ];
          const { port } = scriptedExports(jobs);
          const h = harness(port);
          const outcome = await openReadView(h.options);
          expect(outcome.status).toBe('shown');
          expect(h.opened).toEqual(['https://signed.example/x.pdf']);
          expect(h.progress.map((p) => p.state)).toEqual(stages);
        },
      ),
      { numRuns: 100 },
    );
  });
});
