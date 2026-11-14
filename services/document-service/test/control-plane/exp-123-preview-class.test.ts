// Previews and raw compile logs per visibility class (EXP-123 criterion 4; ADR 0019; 09 §2). A
// cached result is shared only inside its visibility class (the view token is part of the request
// key); a copy of it made for another requester carries no raw log; and no other user can read the
// job.
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

/** The legal region is hidden from everyone but owners and its grantees (as in exp-123-requester). */
const visibility: Visibility = (conn, _doc, perms) =>
  conn.role === 'owner' ||
  perms.grants.some((g) => g.region === LEGAL && g.principal === `user:${conn.sub}`)
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`previews and logs per visibility class (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** The payload of each job the compile handler ran for, by job id. */
    const compiled = new Map<string, Record<string, unknown>>();

    const exportHandler: JobHandler = async (job, ctx) => {
      compiled.set(job.id, job.payload);
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
      'compiles afresh for another visibility class and does not share the cached result (EXP-123 criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const owner = h.userToken({ [doc]: 'owner' });
        const options = { profile: 'final' };

        const v = await post(doc, viewer, options);
        const vJob = await completed(viewer, v.json.id);
        expect(vJob.json.result.url).toBeTypeOf('string');
        expect(compiled.has(v.json.id)).toBe(true);

        // The owner sees the legal region, so the request key differs and the owner compiles.
        const o = await post(doc, owner, options);
        expect(o.status).toBe(202);
        await completed(owner, o.json.id);
        expect(compiled.has(o.json.id)).toBe(true);
        expect(compiled.get(o.json.id)).toMatchObject({ hiddenRegions: [] });
        expect(compiled.get(v.json.id)).toMatchObject({ hiddenRegions: [LEGAL] });
      },
    );

    it.skipIf(skip)(
      'answers a preview of the same class from the cache, with no raw log for the copy and no read for another user (EXP-123 criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const other = h.userToken({ [doc]: 'viewer' }, { sub: 'eva' });
        const options = { profile: 'preview' };

        const first = await post(doc, viewer, options);
        expect(first.status).toBe(202);
        await completed(viewer, first.json.id);
        expect(compiled.has(first.json.id)).toBe(true);

        // The same request from another viewer, the same class, is a cached copy: nothing compiles.
        const copy = await post(doc, other, options);
        expect(copy.status).toBe(202);
        const copyJob = await completed(other, copy.json.id);
        expect(compiled.has(copy.json.id)).toBe(false);
        expect(copyJob.json.result.url).toBeTypeOf('string');
        expect(copyJob.json.result.log).toBeUndefined();

        // The first viewer's job is still readable only by its requester.
        const stolen = await h.call('GET', `/v1/exports/${first.json.id}`, { token: other });
        expect(stolen.status).toBe(403);
        expect(stolen.json.code).toBe('forbidden');
      },
      30_000,
    );
  });
}
