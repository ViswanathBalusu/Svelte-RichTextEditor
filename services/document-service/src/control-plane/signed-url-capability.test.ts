// SEC-046 criteria 1 and 6 (10 §3.7): a signed URL is issued only to a caller with the capability
// that reads the object (export result, asset resolve), a caller whose access has been revoked gets
// no new URL, and an issued URL ends at its expiry, which the asset-worker README and the control
// plane's default (300 s) state. Runs over the control plane's HTTP surface with the in-memory
// data plane of the test harness, as export-jobs.test.ts does; the compile worker is a stand-in
// handler that writes a PDF under the job's prefix.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import type { JobHandler } from './jobs/runner.ts';

/** The default lifetime of a signed URL, in milliseconds (DOCEDIT_SIGNED_URL_SECONDS = 300). */
const FIVE_MINUTES = 300_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`SEC-046 signed URLs need the capability and end at expiry (${storage})`, async () => {
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
      if (!skip)
        h = await startHarness(storage, {
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    const post = (doc: string, token: string) =>
      h.call('POST', `/v1/documents/${doc}/exports`, { token, body: { target: 'pdf' } });

    /** Polls the job until it completes, as the requester sees it. */
    async function completed(token: string, job: string) {
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        if (r.json?.state === 'completed') return r;
        await sleep(20);
      }
      throw new Error(`job ${job} did not complete`);
    }

    /** A refusal: an error status, and no signed URL anywhere in the body. */
    function expectNoUrl(r: { status: number; text: string; json: unknown }, what: string) {
      expect([401, 403, 404], what).toContain(r.status);
      expect(r.text, what).not.toMatch(/"url"|output\.pdf|X-Amz|Signature=/);
    }

    it.skipIf(skip)(
      'issues no signed URL to a caller without the capability (export result and asset resolve)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const job = (await post(doc, editor)).json.id as string;
        const done = await completed(editor, job);
        expect(typeof done.json.result.url).toBe('string'); // the requester does get one

        const stranger = h.userToken({}, { sub: 'mallory' });
        expectNoUrl(await h.call('GET', `/v1/exports/${job}`, { token: stranger }), 'export read');
        expectNoUrl(await post(doc, stranger), 'export start');
        const resolve = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: stranger,
          body: { assets: ['0190a000-0000-7000-8000-000000000001'] },
        });
        expectNoUrl(resolve, 'asset resolve');
      },
    );

    it.skipIf(skip)(
      'a revoked user gets no new URL, and the URL already issued ends at its expiry',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const job = (await post(doc, editor)).json.id as string;
        const done = await completed(editor, job);
        const issuedAt = h.now();
        const expiresAt = Date.parse(done.json.result.expiresAt as string);
        // The lifetime of the URL is five minutes, to the second.
        expect(Math.abs(expiresAt - (issuedAt + FIVE_MINUTES))).toBeLessThanOrEqual(1000);

        // Access is revoked: the host mints a token that no longer names the document.
        const revoked = h.userToken({}, { sub: 'eva' });
        expectNoUrl(
          await h.call('GET', `/v1/exports/${job}`, { token: revoked }),
          'read after revocation',
        );
        expectNoUrl(await post(doc, revoked), 'new request after revocation');

        // The outstanding URL is not withdrawn; it is past its expiry once the lifetime has passed.
        h.advance(FIVE_MINUTES + 1000);
        expect(expiresAt).toBeLessThan(h.now());
      },
    );
  });
}
