// BE-085 criterion 1, the drivers the earlier tests leave out: preview compiles (apart from final
// compiles), the bytes of export outputs under the stored-bytes kinds, and the log bytes of
// commits. Memory storage, in-process service over HTTP, scraped from `/metrics` with the tenant
// label.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const METRICS_TOKEN = 'be-085-drivers-token';
const OUTPUT = Buffer.from('%PDF-1.7 test');

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const compile: JobHandler = async (job, ctx) => {
  await ctx.report('compiling', 50);
  // The runner times a job with a millisecond clock and the meter skips a zero add, so a compile
  // that finishes within one tick leaves no seconds sample. Let this one take measurable time.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await h!.service.assets.putExport(job.tenant, job.id, 'output.pdf', OUTPUT, 'application/pdf');
  return {
    output: 'output.pdf',
    pages: 1,
    layout: null,
    converged: true,
    log: null,
    diagnostics: [],
  };
};

/** The value of the sample of `name` for the harness tenant whose labels contain `extra`. */
async function sample(name: string, extra = ''): Promise<number | null> {
  const r = await h!.call('GET', '/metrics', { token: METRICS_TOKEN });
  const text = String((r as unknown as { text?: string }).text ?? '');
  const line = text
    .split('\n')
    .find(
      (l) => l.startsWith(`${name}{`) && l.includes(`tenant="${h!.tenant}"`) && l.includes(extra),
    );
  return line ? Number(line.split(' ').pop()) : null;
}

async function settle(id: string, token: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await h!.call('GET', `/v1/exports/${id}`, { token });
    if (r.json?.state === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The meter is written when the job settles; give the runner's hook a moment.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe('BE-085 criterion 1: the other cost drivers are metered per tenant', () => {
  it('counts a preview compile apart from a final compile, and the bytes of the output as stored bytes of kind export', async () => {
    h = await startHarness('memory', {
      config: { testMode: true, environment: 'test', metricsToken: METRICS_TOKEN, jobIdleMs: 20 },
      jobHandlers: { export: compile },
    });
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    const preview = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { profile: 'preview' } },
    });
    expect(preview.status).toBe(202);
    await settle(preview.json.id, owner);

    expect(await sample('docedit_tenant_preview_compiles_total')).toBe(1);
    expect(await sample('docedit_tenant_final_compiles_total')).toBeNull();
    expect(await sample('docedit_tenant_compile_seconds_total', 'kind="preview"')).not.toBeNull();
    expect(await sample('docedit_tenant_stored_bytes_total', 'kind="export"')).toBe(OUTPUT.length);

    const final = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(final.status).toBe(202);
    await settle(final.json.id, owner);
    expect(await sample('docedit_tenant_final_compiles_total')).toBe(1);
    expect(await sample('docedit_tenant_preview_compiles_total')).toBe(1);
    expect(await sample('docedit_tenant_stored_bytes_total', 'kind="export"')).toBe(
      2 * OUTPUT.length,
    );
  });
});
