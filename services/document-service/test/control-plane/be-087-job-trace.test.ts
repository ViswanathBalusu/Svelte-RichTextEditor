/**
 * BE-087 criterion 4 (lane V-BE-085-098): a job queued by a REST request runs under the request's
 * trace. The export request carries `traceparent`; the worker that runs the export records a
 * `job.run` span whose trace is the request's and whose parent is the request span. Memory storage,
 * in-process service over HTTP, the compile worker a stand-in handler.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import type { Span } from '../../src/seams.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const TRACE = '6bf92f3577b34da6a3ce929d0e0e4738';
const PARENT = '20f067aa0ba902b9';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const compile: JobHandler = async (job) => {
  await h!.service.assets.putExport(
    job.tenant,
    job.id,
    'output.pdf',
    Buffer.from('%PDF-1.7 test'),
    'application/pdf',
  );
  return {
    output: 'output.pdf',
    pages: 1,
    layout: null,
    converged: true,
    log: null,
    diagnostics: [],
  };
};

describe('a job queued by a request runs under the request trace (BE-087 criterion 4)', () => {
  it('records the job run span in the trace of the export request, under the request span', async () => {
    const spans: Span[] = [];
    h = await startHarness('memory', {
      config: { testMode: true, environment: 'test', jobIdleMs: 20 },
      jobHandlers: { export: compile },
      onSpan: (s) => void spans.push(s),
    });
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    spans.length = 0;
    const started = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      headers: { traceparent: `00-${TRACE}-${PARENT}-01` },
      body: { target: 'pdf' },
    });
    expect(started.status).toBe(202);
    for (let i = 0; i < 300; i++) {
      const r = await h.call('GET', `/v1/exports/${started.json.id}`, { token: owner });
      if (r.json?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const request = spans.find((s) => s.name === 'http.request' && s.traceId === TRACE);
    expect(request).toBeDefined();
    const run = spans.find((s) => s.name === 'job.run');
    expect(run).toBeDefined();
    expect(run!.traceId).toBe(TRACE);
    expect(run!.parentSpanId).toBe(request!.spanId);
  });
});
