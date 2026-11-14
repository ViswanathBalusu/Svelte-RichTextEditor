// EXP-009 criteria 1 and 2 over HTTP: the worker time of a settled export counts against the
// tenant, and a request made with the budget used up is refused with `quota_exceeded` and a
// `Retry-After`, and no job is created (09 §9.1; 06 §12). Memory storage only: the ledger is not
// durable yet (see the story Notes).
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_KIND, PREVIEW_KIND } from '../../src/control-plane/exports.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { MemoryQuotaStore } from '../../src/control-plane/quotas.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

/** A compile that takes `ms` of worker time. */
function slowExport(ms: number): JobHandler {
  return async (job, ctx) => {
    await ctx.report('compiling', 50);
    await new Promise((resolve) => setTimeout(resolve, ms));
    await h.service.assets.putExport(
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
}

let h: Harness;
let open = false;

afterEach(async () => {
  if (open) await h.close();
  open = false;
});

async function start(budgetMinutes: number | null, compileMs: number) {
  const quotas = new MemoryQuotaStore(() => true);
  h = await startHarness('memory', {
    parts: { quotas },
    jobHandlers: { export: slowExport(compileMs) },
    config: { jobIdleMs: 20, jobLeaseMs: 2000 },
  });
  open = true;
  if (budgetMinutes !== null) quotas.set(h.tenant, 'exportMinutes', budgetMinutes);
  return quotas;
}

async function waitCompleted(token: string, job: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await h.call('GET', `/v1/exports/${job}`, { token });
    if (r.json?.state === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${job} did not complete`);
}

describe('EXP-009 compile-minute budget over HTTP (memory)', () => {
  it('counts the worker time of a settled export and refuses the next request (criteria 1, 2)', async () => {
    // 60 ms of budget; the compile takes 150 ms, so one export uses the whole budget.
    await start(0.001, 150);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });

    const first = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(first.status).toBe(202);
    await waitCompleted(owner, first.json.id);
    // The job is settled after its state is written; give the runner's hook a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { fields: 'blank' } },
    });
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe('quota_exceeded');
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
    expect(await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND)).not.toBeNull();
  });

  it('refuses a preview too, and creates no job, when the budget is zero (criterion 2)', async () => {
    await start(0, 10);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    const preview = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { profile: 'preview' } },
    });
    expect(preview.status).toBe(429);
    expect(preview.json.code).toBe('quota_exceeded');
    expect(await h.parts.queue.latestFor(h.tenant, doc, PREVIEW_KIND)).toBeNull();
    expect(await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND)).toBeNull();
  });

  it('accepts exports when no budget is set', async () => {
    await start(null, 10);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    const exported = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(exported.status).toBe(202);
  });

  it('accepts the export again once the budget is raised in the quota store', async () => {
    const quotas = await start(0, 10);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(refused.status).toBe(429);
    quotas.set(h.tenant, 'exportMinutes', 10);
    const accepted = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(accepted.status).toBe(202);
  });
});
