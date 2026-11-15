// BE-092 criteria 2 and 4 over HTTP (memory storage, lane V-BE-085-098): a tenant whose monthly
// compile-minute budget is spent is refused with `quota_exceeded` and a `Retry-After` equal to the
// seconds to the next UTC month, and a job already running when the budget is spent is not killed.
// The export and preview budgets are the EXP-009 ledger (src/control-plane/exp-009-compile-budget.ts).
import { checkProblem } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_KIND } from '../../src/control-plane/exports.ts';
import { secondsToNextMonth } from '../../src/control-plane/exp-009-compile-budget.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { MemoryQuotaStore } from '../../src/control-plane/quotas.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

/** A compile that takes `ms` of worker time and then writes its output. */
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

async function start(budgetMinutes: number | null, compileMs: number): Promise<MemoryQuotaStore> {
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

async function waitState(token: string, job: string, state: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await h.call('GET', `/v1/exports/${job}`, { token });
    if (r.json?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${job} did not reach ${state}`);
}

describe('BE-092 compile-minute budget over HTTP (memory)', () => {
  it('answers quota_exceeded with Retry-After to the next UTC month once the budget is spent (criterion 2)', async () => {
    // 60 ms of budget; the compile takes 150 ms, so one export spends the whole budget.
    await start(0.001, 150);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });

    const first = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(first.status).toBe(202);
    await waitState(owner, first.json.id, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = h.now();
    const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { fields: 'blank' } },
    });
    const after = h.now();
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe('quota_exceeded');
    const retryAfter = Number(refused.headers.get('retry-after'));
    // PRO-038 criterion 3: a registry code on its surface, with the retry hint.
    expect(
      checkProblem({
        surface: 'rest',
        code: refused.json.code,
        retryAfterHeader: refused.headers.get('retry-after') ?? undefined,
      }),
    ).toEqual([]);
    // The clock may tick between the request and the check: allow the seconds it took.
    const expectedLow = secondsToNextMonth(after);
    const expectedHigh = secondsToNextMonth(before);
    expect(retryAfter).toBeGreaterThanOrEqual(expectedLow);
    expect(retryAfter).toBeLessThanOrEqual(expectedHigh);
  });

  it('does not kill a job already running when the budget is spent (criterion 4)', async () => {
    const quotas = await start(null, 300);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });

    const started = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(started.status).toBe(202);
    // The budget is spent while the compile is running.
    quotas.set(h.tenant, 'exportMinutes', 0);

    await waitState(owner, started.json.id, 'completed');
    const job = await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND);
    expect(job).not.toBeNull();
    expect(job?.state).toBe('completed');

    // The next request is refused, so the running job was not the only thing the budget stopped.
    const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { fields: 'blank' } },
    });
    expect(refused.status).toBe(429);
  });
});
