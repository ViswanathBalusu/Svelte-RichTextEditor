// The raw compile log is for editors (EXP-066 criteria 1, 2 and 4; 07 §12; owner decision 150).
// Callers without `edit` get the job without a log URL, as the route is built. The log is stored
// under the job's prefix beside the result and is signed with the result's expiry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'Asia/Kolkata',
  'Australia/Sydney',
];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`raw compile log of an export (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    const exportHandler: JobHandler = async (job, ctx) => {
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
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    async function completed(token: string, job: string) {
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        if (r.json?.state === 'completed') return r;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`job ${job} did not complete`);
    }

    /** The expiry carried in a signed URL, whichever name the signer gives it. */
    const expiryOf = (url: string): string => {
      const q = new URL(url).searchParams;
      return q.get('exp') ?? q.get('expires') ?? q.get('X-Amz-Expires') ?? 'none';
    };

    it.skipIf(skip)(
      'gives the log URL to callers with edit, and the job without it to every other role',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const withLog: string[] = [];
        const withoutLog: string[] = [];
        // Each role requests its own job; distinct options keep the jobs from sharing a cached result.
        const roles = ['viewer', 'commenter', 'suggester', 'filler', 'editor', 'owner'] as const;
        for (const [i, role] of roles.entries()) {
          const token = h.userToken({ [doc]: role }, { sub: `user-${role}` });
          const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token,
            body: { target: 'pdf', options: { timeZone: ZONES[i]! } },
          });
          expect(created.status, role).toBe(202);
          const done = await completed(token, created.json.id);
          expect(done.status, role).toBe(200);
          expect(done.json.result.url, role).toBeTypeOf('string');
          (done.json.result.log === undefined ? withoutLog : withLog).push(role);
          if (done.json.result.log !== undefined) {
            // The log shares the expiry of the result it belongs to (criterion 4).
            expect(expiryOf(done.json.result.log), role).toBe(expiryOf(done.json.result.url));
            expect(done.json.result.log, role).toContain('compile.log');
          }
        }
        expect(withLog).toEqual(['editor', 'owner']);
        expect(withoutLog).toEqual(['viewer', 'commenter', 'suggester', 'filler']);
      },
    );

    it.skipIf(skip)('gives the log to a service credential', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = h.userToken({ [doc]: 'owner' });
      const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token: owner,
        body: { target: 'pdf', options: { timeZone: 'Asia/Tokyo' } },
      });
      await completed(owner, created.json.id);
      const viaService = await h.call('GET', `/v1/exports/${created.json.id}`, {
        token: h.apiKey,
      });
      expect(viaService.json.result.log).toContain('compile.log');
    });
  });
}
