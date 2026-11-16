// EXP-011 criterion 5 (08 §12): the host reads a completed export through `GET /v1/exports/{jid}`,
// and the result carries the chain head the worker wrote into the manifest, so that the host can
// anchor it. Real HTTP over the memory stores, with a stand-in for the compile worker; that the
// worker puts the manifest's head into its result is checked in
// services/export-worker/src/his-034-chain-head.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportOutputs } from '../../src/control-plane/handlers.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const HEAD = 'ab'.repeat(32);

async function completed(h: Harness, token: string, job: string) {
  for (let i = 0; i < 200; i++) {
    const r = await h.call('GET', `/v1/exports/${job}`, { token });
    if (r.json?.state === 'completed' || r.json?.state === 'failed') return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${job} did not finish`);
}

describe('EXP-011 criterion 5: the export result gives the host the chain head', () => {
  let h: Harness;
  // What the stand-in worker reports as the chain head of the next job; undefined reports none.
  let reported: string | null | undefined;
  const exportHandler: JobHandler = async (job) => {
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'output.pdf',
      Buffer.from('%PDF-1.7 test'),
      'application/pdf',
    );
    const out: ExportOutputs = {
      output: 'output.pdf',
      pages: 1,
      layout: null,
      converged: true,
      log: null,
      diagnostics: [],
      ...(reported !== undefined ? { chainHead: reported } : {}),
    };
    return out as unknown as Record<string, unknown>;
  };

  beforeAll(async () => {
    h = await startHarness('memory', {
      jobHandlers: { export: exportHandler },
      config: { jobIdleMs: 20, jobLeaseMs: 2000 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function exportOnce(token: string, doc: string) {
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token,
      body: { target: 'pdf' },
    });
    expect(r.status).toBe(202);
    return { id: r.json.id as string, done: await completed(h, token, r.json.id) };
  }

  it('returns the chain head of the worker result, also for a result served from the cache', async () => {
    reported = HEAD;
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const first = await exportOnce(editor, doc);
    expect(first.done.json.state).toBe('completed');
    expect(first.done.json.result.chainHead).toBe(HEAD);
    // The same request again: the result is the first job's, and the head comes with it.
    reported = 'cd'.repeat(32);
    const second = await exportOnce(editor, doc);
    expect(second.done.json.result.chainHead).toBe(HEAD);
  });

  it('returns null when the worker found no commit at that seq, and nothing when it reports none', async () => {
    reported = null;
    const a = await h.createDocument({ content: documentWithRegions() });
    const none = await exportOnce(h.userToken({ [a]: 'editor' }), a);
    expect(none.done.json.result).toHaveProperty('chainHead', null);

    reported = undefined;
    const b = await h.createDocument({ content: documentWithRegions() });
    const absent = await exportOnce(h.userToken({ [b]: 'editor' }), b);
    expect(absent.done.json.state).toBe('completed');
    expect(absent.done.json.result).not.toHaveProperty('chainHead');
  });
});
