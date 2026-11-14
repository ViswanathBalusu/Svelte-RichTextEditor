// EXP-086 criterion 4: the `cdm` target follows the same job states, permission and `no-export`
// rules as the other targets (09 §11; 05 §6.2). Lane U-EXP-081-096. The job is run by a stand-in
// handler, as in routes.exports.test.ts: the service's gates and states are what is tested here,
// not the canonical JSON writer (EXP-086 criteria 1 to 3 are tested in export-latex).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportOutputs } from '../../src/control-plane/handlers.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** Waits for a job to reach one of `states` through the API. */
async function until(h: Harness, token: string, job: string, states: string[]) {
  for (let i = 0; i < 200; i++) {
    const r = await h.call('GET', `/v1/exports/${job}`, { token });
    if (states.includes(r.json?.state)) return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${job} did not reach ${states.join(' or ')}`);
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-086 cdm target job rules (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const seen: string[] = [];
    const exportHandler: JobHandler = async (job, ctx) => {
      seen.push(String(job.payload['target']));
      await ctx.report('converting', 10);
      await ctx.report('compiling', 60);
      await h.service.assets.putExport(
        job.tenant,
        job.id,
        'output.json',
        Buffer.from('{"cdm":1}'),
        'application/json',
      );
      const out: ExportOutputs = {
        output: 'output.json',
        pages: 0,
        layout: null,
        converged: true,
        log: null,
        diagnostics: [],
      } as unknown as ExportOutputs;
      return out as unknown as Record<string, unknown>;
    };

    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000, exportTargets: ['pdf', 'cdm'] },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'runs a cdm job through the same queued, running and completed states as pdf (EXP-086 criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const cdm = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: editor,
          body: { target: 'cdm' },
        });
        expect(cdm.status).toBe(202);
        expect(cdm.json).toMatchObject({ doc, target: 'cdm', state: 'queued' });
        const done = await until(h, editor, cdm.json.id, ['completed', 'failed']);
        expect(done.json.state).toBe('completed');
        expect(done.json.progress).toBe(100);
        expect(seen).toContain('cdm');
      },
    );

    it.skipIf(skip)(
      'applies the view permission and the no-export restriction to cdm as to pdf (EXP-086 criterion 4; 07 §12)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const stranger = h.userToken({});
        const restricted = h.userToken({ [doc]: 'owner' }, { restrict: ['no-export'] });
        // A viewer may request the cdm target, as for pdf.
        const allowed = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'cdm' },
        });
        expect(allowed.status).toBe(202);
        // A caller with no role on the document is refused, as for pdf.
        const none = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: stranger,
          body: { target: 'cdm' },
        });
        expect(none.status).not.toBe(202);
        // A caller restricted with no-export is refused, as for pdf.
        const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: restricted,
          body: { target: 'cdm' },
        });
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('forbidden');
        const pdf = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: restricted,
          body: { target: 'pdf' },
        });
        expect(pdf.status).toBe(refused.status);
        expect(pdf.json.code).toBe(refused.json.code);
      },
    );
  });
}
