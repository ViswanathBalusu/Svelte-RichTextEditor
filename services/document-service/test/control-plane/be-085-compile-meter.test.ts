// BE-085 criterion 1, the compile-minute counters (lane V-BE-085-098): a settled export counts its
// compile seconds and one final compile against its tenant, and the scrape carries both with the
// tenant label and no document content. Memory storage, in-process service over HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const METRICS_TOKEN = 'be-085-compile-meter-token';
const COMPILE_MS = 150;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const compile: JobHandler = async (job, ctx) => {
  await ctx.report('compiling', 50);
  await new Promise((resolve) => setTimeout(resolve, COMPILE_MS));
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

describe('BE-085 criterion 1: compile minutes are metered per tenant', () => {
  it('counts the compile seconds and the final compile of a settled export, with the tenant label', async () => {
    h = await startHarness('memory', {
      config: { testMode: true, environment: 'test', metricsToken: METRICS_TOKEN, jobIdleMs: 20 },
      jobHandlers: { export: compile },
    });
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    const started = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(started.status).toBe(202);
    for (let i = 0; i < 300; i++) {
      const r = await h.call('GET', `/v1/exports/${started.json.id}`, { token: owner });
      if (r.json?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The meter is written when the job settles; give the runner's hook a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const r = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
    expect(r.status).toBe(200);
    const text = String((r as unknown as { text?: string }).text ?? '');
    const seconds = text
      .split('\n')
      .find(
        (l) =>
          l.startsWith('docedit_tenant_compile_seconds_total{') &&
          l.includes(`tenant="${h!.tenant}"`),
      );
    expect(seconds).toBeDefined();
    // At least the compile time, and the sample is a number of seconds.
    const value = Number(seconds!.split(' ').pop());
    expect(value).toBeGreaterThanOrEqual(COMPILE_MS / 1000);
    const finals = text
      .split('\n')
      .find(
        (l) =>
          l.startsWith('docedit_tenant_final_compiles_total{') &&
          l.includes(`tenant="${h!.tenant}"`),
      );
    expect(finals).toBeDefined();
    expect(Number(finals!.split(' ').pop())).toBe(1);
    // No document text in the scrape (BE-085 criterion 2).
    expect(text).not.toContain('Repair');
  });
});
