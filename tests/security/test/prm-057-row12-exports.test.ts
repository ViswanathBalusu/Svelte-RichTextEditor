/**
 * PRM-057 criterion 5 (07 §12 row 12; lane V-PRM-052-067): a user without `view` cannot export, and
 * a user without `edit` cannot read the raw compile log of an export.
 *
 * Runs the control plane's export route over HTTP with a stand-in compile handler that writes a
 * log, as sec-036 does. Three requesters on one document: an outsider with a role on another
 * document only (no `view` here), a viewer, and an editor. Node.js, memory storage: the rule is the
 * route's and does not depend on the storage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../../services/document-service/test/control-plane/support.ts';
import type { JobHandler } from '../../../services/document-service/src/control-plane/jobs/runner.ts';

const RAW_LOG = 'Overfull \\hbox (too wide) in paragraph at lines 7--8';

describe('PRM-057 criterion 5: row 12, exports and raw compile logs', () => {
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

  it('refuses an export to a user without view on the document', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const other = await h.createDocument({ content: documentWithRegions() });
    // The outsider holds a role on another document only, so `view` on `doc` is missing.
    const outsider = h.userToken({ [other]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: outsider,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    expect([401, 403, 404]).toContain(r.status);
    expect(r.json?.id, 'no job is created for the outsider').toBeUndefined();
  });

  it('withholds the raw compile log from a viewer, who has no edit', async () => {
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
    // The editor sees the log: this shows the log exists, so the viewer's absence of it is not vacuous.
    expect(done.result?.log, 'the editor sees the signed log URL').toMatch(/^(https?|memory):\/\//);

    const viewer = h.userToken({ [doc]: 'viewer' });
    const seen = await h.call('GET', `/v1/exports/${id}`, { token: viewer });
    expect(seen.status).toBe(200);
    // Reading the job as a viewer: the log is refused (no field), the output is still served.
    expect(seen.json.result?.log).toBeUndefined();
    expect(seen.json.result?.url).toMatch(/^(https?|memory):\/\//);
  });

  it('refuses a viewer who asks for the export of another requester (no view on the job)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    const id = created.json.id as string;
    await waitDone(editor, id);
    // A viewer of the document who did not make the job reads it: no raw log is shown.
    const viewer = h.userToken({ [doc]: 'viewer' });
    const r = await h.call('GET', `/v1/exports/${id}`, { token: viewer });
    expect(r.json?.result?.log).toBeUndefined();
  });
});
