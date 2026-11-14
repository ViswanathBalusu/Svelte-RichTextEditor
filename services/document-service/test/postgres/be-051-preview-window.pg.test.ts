// BE-051 criterion 1 on PostgreSQL (lane U-BE-043-056): inside the ten-second window of a preview,
// a second preview of the same document from another requester is queued and no compile starts
// for it; it compiles only once the window has passed. The harness here runs on the real clock
// (no advance), so the window is measured by the database's job times and the service's clock
// together. The export-jobs test covers the same rule on the in-memory store and with a moved clock,
// which the PostgreSQL run cannot share (see BE-051 Notes).
// Skips, with the reason, when the integration environment is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

const reason = await skipReason('postgres');
if (reason) console.warn(`be-051-preview-window: skipped: ${reason}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(reason !== null)(
  'BE-051 criterion 1 on PostgreSQL: no second preview compile inside the window',
  () => {
    let h: Harness;
    const ran: string[] = [];

    const handler: JobHandler = async (job, ctx) => {
      ran.push(job.id);
      await ctx.report('compiling', 60);
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

    beforeAll(async () => {
      h = await startHarness('postgres', {
        jobHandlers: { export: handler },
        config: { jobIdleMs: 20, jobLeaseMs: 2000 },
      });
    }, 120_000);

    afterAll(async () => {
      await h?.close();
    });

    it("queues a second requester's preview until the window has passed", async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const a = h.userToken({ [doc]: 'editor' });
      const b = h.userToken({ [doc]: 'editor' }, { sub: 'eva' });
      const post = (token: string, tagging: string) =>
        h.call('POST', `/v1/documents/${doc}/exports`, {
          token,
          body: { target: 'pdf', options: { profile: 'preview', tagging } },
        });
      const state = async (token: string, id: string) =>
        (await h.call('GET', `/v1/exports/${id}`, { token })).json.state as string;

      const first = (await post(a, 'draft')).json.id as string;
      for (let i = 0; i < 400 && (await state(a, first)) !== 'completed'; i++) await sleep(25);
      expect(await state(a, first)).toBe('completed');
      expect(ran).toEqual([first]);

      // Another requester's preview straight after the first compile: inside the window.
      const second = await post(b, 'off');
      expect(second.json.state).toBe('queued');
      const secondId = second.json.id as string;
      await sleep(1_500);
      expect(ran).toEqual([first]);
      expect(await state(b, secondId)).toBe('queued');

      // After the window the queued preview compiles, and only then.
      for (let i = 0; i < 800 && (await state(b, secondId)) !== 'completed'; i++) await sleep(25);
      expect(await state(b, secondId)).toBe('completed');
      expect(ran).toEqual([first, secondId]);
    }, 60_000);
  },
);
