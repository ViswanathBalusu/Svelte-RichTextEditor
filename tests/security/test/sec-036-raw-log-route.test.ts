/**
 * SEC-036 criterion 4 (lane U-SEC-033-048): raw compile logs are shown only to callers with `edit`.
 *
 * Runs the control plane's export route over HTTP (EXP-066; services/document-service/src/
 * control-plane/export-routes.ts, `ownJob`, which sets `canSeeLog`), with a stand-in compile handler
 * that writes a log under the job's prefix, as the export-jobs suite does. The requester who holds
 * `edit` sees the signed log URL; the same requester after a demotion to `view` does not. Node.js,
 * memory storage: the rule is the route's and does not depend on the storage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../../services/document-service/test/control-plane/support.ts';
import type { JobHandler } from '../../../services/document-service/src/control-plane/jobs/runner.ts';

const RAW_LOG = 'Overfull \\hbox (too wide) in paragraph at lines 3--4';

describe('SEC-036 criterion 4: the raw compile log is shown only to callers with edit', () => {
  let h: Harness;

  const compileHandler: JobHandler = async (job, ctx) => {
    await ctx.report('compiling', 60);
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'output.pdf',
      Buffer.from('%PDF-1.7 test'),
      'application/pdf',
    );
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'compile.log',
      Buffer.from(RAW_LOG),
      'text/plain',
    );
    return {
      output: 'output.pdf',
      pages: 1,
      layout: null,
      converged: true,
      log: 'compile.log',
      diagnostics: [],
    };
  };

  beforeAll(async () => {
    h = await startHarness('memory', {
      jobHandlers: { export: compileHandler },
      config: { jobIdleMs: 20, jobLeaseMs: 2000 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function waitDone(token: string, job: string) {
    for (let i = 0; i < 200; i++) {
      const r = await h.call('GET', `/v1/exports/${job}`, { token });
      if (r.json?.state === 'completed' || r.json?.state === 'failed') return r.json;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`job ${job} did not finish`);
  }

  it('shows the log URL to the requester with edit, and not after the same requester is demoted to view', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    expect(created.status).toBeLessThan(300);
    const id = created.json.id as string;

    const done = await waitDone(editor, id);
    expect(done.state).toBe('completed');
    expect(done.result?.log, 'an editor sees the signed log URL').toMatch(/^(https?|memory):\/\//);

    // The same requester, now with view only: the job is still theirs, but the log is withheld.
    const viewer = h.userToken({ [doc]: 'viewer' });
    const seen = await h.call('GET', `/v1/exports/${id}`, { token: viewer });
    expect(seen.status).toBe(200);
    expect(seen.json.result?.log).toBeUndefined();
    expect(seen.json.result?.url).toMatch(/^(https?|memory):\/\//);
  });

  it('withholds the log from a requester who holds only view and never had edit', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const viewer = h.userToken({ [doc]: 'viewer' });
    const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: viewer,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    // A viewer's export is either refused (then no log can reach them) or runs and withholds the log.
    if (created.status >= 300) {
      expect([401, 403, 404]).toContain(created.status);
      return;
    }
    const id = created.json.id as string;
    const done = await waitDone(viewer, id);
    expect(done.state).toBe('completed');
    expect(done.result?.log).toBeUndefined();
  });
});
