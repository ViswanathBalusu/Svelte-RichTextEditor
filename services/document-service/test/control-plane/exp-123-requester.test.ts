// Export as the requester over real HTTP (EXP-123 criteria 1 and 4; ADR 0019; 09 §2). A full export
// needs `manage` and the explicit option; a projected export records the requester's class, so the
// worker builds the bundle from that projection; the raw log and the job belong to its requester.
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';

/** The legal region is hidden from everyone but owners and its grantees (as in routes.exports-gate). */
const visibility: Visibility = (conn, _doc, perms) =>
  conn.role === 'owner' ||
  perms.grants.some((g) => g.region === LEGAL && g.principal === `user:${conn.sub}`)
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`export as the requester (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** The payload each export job was created with, by job id. */
    const payloads = new Map<string, Record<string, unknown>>();

    const exportHandler: JobHandler = async (job, ctx) => {
      payloads.set(job.id, job.payload);
      await ctx.report('converting', 10);
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
        Buffer.from('raw compile log'),
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
      if (!skip)
        h = await startHarness(storage, {
          views: { ...FULL_VIEWS, visibility },
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    /** Polls the job until it is completed, and returns the last response. */
    async function completed(token: string, job: string) {
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        if (r.json?.state === 'completed') return r;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const last = await h.call('GET', `/v1/exports/${job}`, { token });
      throw new Error(`job ${job} did not complete: ${JSON.stringify(last.json)}`);
    }

    const post = (doc: string, token: string, options?: Record<string, unknown>) =>
      h.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        body: options === undefined ? { target: 'pdf' } : { target: 'pdf', options },
      });

    it.skipIf(skip)(
      'gives a full export only to a manager who asks for it, and projects every other export (EXP-123 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const owner = h.userToken({ [doc]: 'owner' });

        // Full without manage is refused, and no job is created.
        for (const token of [editor, viewer]) {
          const refused = await post(doc, token, { full: true });
          expect(refused.status).toBe(403);
          expect(refused.json.code).toBe('forbidden');
        }

        // A manager without the option gets a projected export.
        const projected = await post(doc, owner);
        expect(projected.status).toBe(202);
        const ownerJob = await completed(owner, projected.json.id);
        expect(ownerJob.status).toBe(200);
        expect(payloads.get(projected.json.id)).toMatchObject({
          full: false,
          role: 'owner',
          hiddenRegions: [],
        });

        // A manager with the option gets the full document.
        const full = await post(doc, owner, { full: true, profile: 'final' });
        expect(full.status).toBe(202);
        await completed(owner, full.json.id);
        expect(payloads.get(full.json.id)).toMatchObject({ full: true, role: 'owner' });

        // A viewer's export is built from the viewer's projection, which hides the legal region.
        const viewed = await post(doc, viewer);
        expect(viewed.status).toBe(202);
        await completed(viewer, viewed.json.id);
        expect(payloads.get(viewed.json.id)).toMatchObject({
          full: false,
          role: 'viewer',
          hiddenRegions: [LEGAL],
        });
      },
    );

    it.skipIf(skip)(
      'keeps the raw log with its requester, and the job with its requester only (EXP-123 criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const editor = h.userToken({ [doc]: 'editor' });
        const other = h.userToken({ [doc]: 'viewer' }, { sub: 'eva' });

        // A viewer's job carries no raw log: a viewer may not see compile logs.
        const v = await post(doc, viewer);
        const vJob = await completed(viewer, v.json.id);
        expect(vJob.json.result).toBeTypeOf('object');
        expect(vJob.json.result.log).toBeUndefined();

        // An editor's job, requested with different options so that it is not a cached copy, has the log.
        const e = await post(doc, editor, { profile: 'final' });
        const eJob = await completed(editor, e.json.id);
        expect(eJob.json.result.log).toBeTypeOf('string');

        // Another user cannot read either job.
        const stolen = await h.call('GET', `/v1/exports/${e.json.id}`, { token: other });
        expect(stolen.status).toBe(404);
        expect(stolen.json.code).toBe('not_found');
      },
    );
  });
}
