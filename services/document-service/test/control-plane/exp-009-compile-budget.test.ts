// EXP-009 criteria 1, 2 and 3 over HTTP: the worker time of an export counts against the tenant,
// a request made with the budget used up is refused with `quota_exceeded` and a `Retry-After` and
// no job is created, and a budget raised through the administration API lets exports through again
// (09 §9.1; 06 §12).
//
// The minutes are the queue's record of worker time (`JobQueue.workerTime`). The first block runs
// the compile in the service's own process, in memory. The second block runs it as the export
// worker's process does: a runner of its own over the same queue, with no hook into the service,
// in memory and on PostgreSQL; the budget is written through `PUT /v1/quotas`.
import { checkProblem } from '@docedit/protocol';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { EXPORT_KIND, PREVIEW_KIND } from '../../src/control-plane/exports.ts';
import { signJws } from '../../src/control-plane/jwt.ts';
import { JobRunner, type JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { MemoryQuotaStore } from '../../src/control-plane/quotas.ts';
import { signingKey } from '../../src/control-plane/tokens.ts';
import { startService } from '../../src/server.ts';
import { startOnFetchablePort } from '../support/ports.ts';
import {
  StubDataPlane,
  documentWithRegions,
  skipReason,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support.ts';

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A compile that takes `ms` of worker time. */
function slowExport(ms: number): JobHandler {
  return async (job, ctx) => {
    await ctx.report('compiling', 50);
    await sleep(ms);
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
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
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

async function waitFor(token: string, job: string, states: string[]): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await h.call('GET', `/v1/exports/${job}`, { token });
    if (states.includes(r.json?.state)) return;
    await sleep(20);
  }
  throw new Error(`job ${job} did not reach ${states.join(' or ')}`);
}

const waitCompleted = (token: string, job: string) => waitFor(token, job, ['completed']);

function expectBudgetRefusal(r: CallResult): void {
  expect(r.status, r.text).toBe(429);
  expect(r.json.code).toBe('quota_exceeded');
  const retryAfter = Number(r.headers.get('retry-after'));
  expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
  // At most a month away: the budget is back at the start of the next UTC month.
  expect(retryAfter).toBeLessThanOrEqual(31 * 24 * 60 * 60);
  expect(
    checkProblem({
      surface: 'rest',
      code: r.json.code,
      retryAfterHeader: r.headers.get('retry-after') ?? undefined,
    }),
  ).toEqual([]);
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
    // The queue kept the worker time with the job.
    const done = await h.parts.queue.get(h.tenant, first.json.id);
    expect(done?.workerMs).toBeGreaterThanOrEqual(140);

    const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { fields: 'blank' } },
    });
    expectBudgetRefusal(refused);
    // The job that ran is still the newest: the refused request created none.
    expect((await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND))?.id).toBe(first.json.id);
  });

  it('refuses a preview too, and creates no job, when the budget is zero (criterion 2)', async () => {
    await start(0, 10);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });
    const preview = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf', options: { profile: 'preview' } },
    });
    expectBudgetRefusal(preview);
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

/** Writes quota values through the administration API, as an operator does (UX-078). */
async function putQuotas(body: Record<string, number>): Promise<void> {
  const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
  expect(read.status, read.text).toBe(200);
  const r = await h.call('PUT', '/v1/quotas', {
    token: h.apiKey,
    body,
    headers: { 'If-Match': read.headers.get('etag')! },
  });
  expect(r.status, r.text).toBe(200);
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-009 compile minutes of jobs a worker of its own runs, with the budget set through PUT /quotas (${storage})`, async () => {
    const skip = await skipReason(storage);

    /**
     * The service without an export handler, and a runner over the same queue that stands for the
     * export worker's process: it has no hook into the service. Its compile waits for `release`.
     */
    async function startWithWorker() {
      h = await startHarness(storage, { config: { jobIdleMs: 20 } });
      open = true;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const held: JobHandler = async (job, ctx) => {
        await ctx.report('compiling', 50);
        await gate;
        await h.service.assets.putExport(
          job.tenant,
          job.id,
          'output.pdf',
          Buffer.from('%PDF-1.7 test'),
          'application/pdf',
        );
        return { output: 'output.pdf', pages: 1, layout: null, converged: true, log: null };
      };
      const worker = new JobRunner({
        queue: h.parts.queue,
        handlers: { [EXPORT_KIND]: held, [PREVIEW_KIND]: held },
        worker: 'export-worker-of-its-own',
        leaseMs: 5000,
        idleMs: 20,
        retryAfterMs: 0,
      });
      worker.start();
      closers.push(async () => {
        release();
        await worker.stop();
      });
      return { release };
    }

    const ask = (doc: string, token: string, options?: Record<string, unknown>) =>
      h.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        body: options ? { target: 'pdf', options } : { target: 'pdf' },
      });

    it.skipIf(skip)(
      'counts the time the worker held the job, refuses on every node of the service, and accepts again once the budget is raised through the administration API (criteria 1, 2, 3)',
      async () => {
        const { release } = await startWithWorker();
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' });
        await putQuotas({ exportMinutes: 1 });

        // One export, which its worker holds for a minute and a second of the queue's clock.
        const first = await ask(doc, owner);
        expect(first.status, first.text).toBe(202);
        await waitFor(owner, first.json.id, ['compiling']);
        // Still inside the budget while the job runs: a job counts when it has ended.
        expect((await ask(doc, owner, { fields: 'blank' })).status).toBe(202);
        h.advance(61_000);
        await h.call('GET', `/v1/exports/${first.json.id}`, { token: owner });
        release();
        await waitCompleted(owner, first.json.id);
        const done = (await h.parts.queue.get(h.tenant, first.json.id))!;
        expect(done.workerMs).toBeGreaterThanOrEqual(61_000);
        expect(
          await h.parts.queue.workerTime(
            h.tenant,
            [EXPORT_KIND, PREVIEW_KIND],
            0,
            Date.UTC(2100, 0),
          ),
        ).toBeGreaterThanOrEqual(61_000);

        // Criterion 2: the budget of one minute is used up. An export and a preview are refused.
        const later = h.userToken({ [doc]: 'owner' });
        expectBudgetRefusal(await ask(doc, later, { tagging: 'draft' }));
        expectBudgetRefusal(await ask(doc, later, { profile: 'preview' }));
        expect(await h.parts.queue.latestFor(h.tenant, doc, PREVIEW_KIND)).toBeNull();

        // A second node of the service over the same storage has counted nothing itself, and
        // refuses all the same: the minutes are with the jobs, not in a process.
        const other = await startOnFetchablePort(
          () =>
            startService({
              config: { ...configFromEnv({}), port: 0, workers: 1, jobIdleMs: 20 },
              parts: h.parts,
              createDataPlane: () => new StubDataPlane(),
              signing: signingKey(undefined, 'service-test'),
              now: () => h.now(),
            }),
          (s) => s.url,
          (s) => s.close(),
        );
        closers.push(() => other.close());
        const iat = Math.floor(h.now() / 1000);
        const there = signJws(
          { alg: h.host.alg, typ: 'JWT', kid: h.host.kid },
          {
            iss: 'https://host.example.test',
            aud: other.url,
            iat,
            exp: iat + 600,
            jti: uuid7(),
            tid: h.tenant,
            sub: 'alice',
            docs: { [doc]: 'owner' },
          },
          h.host.privateKey,
        );
        const elsewhere = await fetch(`${other.url}/v1/documents/${doc}/exports`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${there}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'pdf', options: { tagging: 'off' } }),
        });
        expect(elsewhere.status).toBe(429);
        expect(((await elsewhere.json()) as { code: string }).code).toBe('quota_exceeded');
        expect(Number(elsewhere.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

        // Criterion 3: the operator raises the budget through the administration API, and the
        // next export is accepted.
        await putQuotas({ exportMinutes: 5 });
        const accepted = await ask(doc, later, { tagging: 'draft' });
        expect(accepted.status, accepted.text).toBe(202);
        expect((await h.parts.queue.get(h.tenant, accepted.json.id))?.state).toMatch(
          /^(queued|running|completed)$/,
        );
        // Lowered again below what is used, it refuses again: the budget is read at each request.
        await putQuotas({ exportMinutes: 1 });
        expectBudgetRefusal(await ask(doc, later, { tagging: 'on' }));
      },
    );

    it.skipIf(skip || storage !== 'memory')(
      'gives the tenant its budget back at the start of the next UTC month',
      async () => {
        const { release } = await startWithWorker();
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' });
        await putQuotas({ exportMinutes: 1 });
        const first = await ask(doc, owner);
        await waitFor(owner, first.json.id, ['compiling']);
        h.advance(61_000);
        release();
        await waitCompleted(owner, first.json.id);
        const now = h.userToken({ [doc]: 'owner' });
        expectBudgetRefusal(await ask(doc, now, { tagging: 'draft' }));
        // Thirty-two days on is a day of the next month or of the one after: a new budget.
        h.advance(32 * DAY);
        const next = h.userToken({ [doc]: 'owner' });
        expect((await ask(doc, next, { tagging: 'draft' })).status).toBe(202);
      },
    );
  });
}
