// BE-092 criterion 5: the usage figures an administrator reads (`GET /usage`, UX-078) match the
// counters of BE-085 for the dimensions both have. Memory storage, in-process service over HTTP,
// the real asset worker (unsandboxed, test only) and a compile that takes measurable time.
//
// Two dimensions have a counter in `/metrics`: the storage figure (the stored bytes of the
// tenant's assets, against `docedit_tenant_stored_bytes_total{kind="asset"}`) and the export
// minutes (the compile budget's ledger, against `docedit_tenant_compile_seconds_total`). The
// others (peaks of connections, open documents, commits and CPU in a window, and export jobs at
// once) are peaks, and BE-085 keeps totals, so they have no counter to match.
import { unsandboxed } from '@docedit/asset-worker';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_KIND } from '../../src/control-plane/exports.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const METRICS_TOKEN = 'be-092-usage-token';
const OUTPUT = Buffer.from('%PDF-1.7 test');
/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const compile: JobHandler = async (job, ctx) => {
  await ctx.report('compiling', 50);
  await new Promise((resolve) => setTimeout(resolve, 120));
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

/** The sum of the samples of `name` for the harness tenant. */
async function total(name: string, extra = ''): Promise<number> {
  const r = await h!.call('GET', '/metrics', { token: METRICS_TOKEN });
  const text = String((r as unknown as { text?: string }).text ?? '');
  let sum = 0;
  for (const l of text.split('\n'))
    if (l.startsWith(`${name}{`) && l.includes(`tenant="${h!.tenant}"`) && l.includes(extra))
      sum += Number(l.split(' ').pop());
  return sum;
}

async function until(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the condition was not reached');
}

describe('BE-092 criterion 5: usage figures match the counters of BE-085', () => {
  it('reads storage and export minutes equal to the asset and compile counters of the same tenant', async () => {
    h = await startHarness('memory', {
      assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      jobHandlers: { export: compile },
      config: { testMode: true, environment: 'test', metricsToken: METRICS_TOKEN, jobIdleMs: 20 },
    });
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });

    // Nothing has happened: the figures and the counters are all zero.
    const empty = await h.call('GET', '/v1/usage', { token: h.apiKey });
    expect(empty.status, empty.text).toBe(200);
    expect(empty.json.storage).toBe(0);
    expect(empty.json.exportMinutes).toBe(0);
    expect(await total('docedit_tenant_stored_bytes_total', 'kind="asset"')).toBe(0);
    expect(await total('docedit_tenant_compile_seconds_total')).toBe(0);

    // Two assets go through the worker to `ready`.
    for (const name of ['a.png', 'b.png']) {
      const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token: owner,
        body: { filename: name, mime: 'image/png', size: PNG.length },
      });
      expect(r.status, r.text).toBe(201);
      const id = r.json.asset as string;
      await h.service.assets.putQuarantined(h.tenant, id, PNG);
      expect((await h.call('POST', `/v1/assets/${id}/complete`, { token: owner })).status).toBe(
        202,
      );
      await until(async () => (await h!.parts.assetRegistry.get(h!.tenant, id))?.state === 'ready');
    }
    await until(async () => (await total('docedit_tenant_stored_bytes_total', 'kind="asset"')) > 0);

    // One export runs to the end.
    const started = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(started.status).toBe(202);
    await until(
      async () =>
        (await h!.call('GET', `/v1/exports/${started.json.id}`, { token: owner })).json?.state ===
        'completed',
    );
    await until(async () => (await total('docedit_tenant_compile_seconds_total')) > 0);

    const stored = await total('docedit_tenant_stored_bytes_total', 'kind="asset"');
    const seconds = await total('docedit_tenant_compile_seconds_total');
    const read = await h.call('GET', '/v1/usage', { token: h.apiKey });
    expect(read.status, read.text).toBe(200);

    // Storage: no asset was removed, so the stock the usage reads is the flow the counter holds.
    expect(stored).toBeGreaterThan(0);
    expect(read.json.storage).toBe(stored);
    expect(await h.parts.assetRegistry.storedBytes(h.tenant)).toBe(stored);

    // Export minutes: the ledger of the job queue and the counter time the same job, with two
    // clocks that differ by a few milliseconds; the figure is the whole minutes of the counter.
    expect(seconds).toBeGreaterThanOrEqual(0.1);
    const ledgerSeconds =
      (await h.parts.queue.workerTime(h.tenant, [EXPORT_KIND], 0, Infinity)) / 1000;
    expect(Math.abs(ledgerSeconds - seconds)).toBeLessThan(0.25);
    expect(read.json.exportMinutes).toBe(Math.ceil(seconds / 60));
  });
});
