// SEC-046 criterion 6 (lane V-SEC-033-048, 2026-11-13): after the user's access is revoked through the
// real revocation route (`POST /v1/sessions/revoke`, 05 §3.3), a new signed URL is not issued, and the
// URL already issued keeps the expiry it was given (it is not withdrawn; the documentation states it).
// Runs over the control plane's HTTP surface on memory and on PostgreSQL (docedit-test-postgres, a
// database of its own); the PostgreSQL half is skipped, with the reason, when the database is down.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';

const FIVE_MINUTES = 300_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`SEC-046 criterion 6: revocation stops new URLs (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    const exportHandler: JobHandler = async (job, ctx) => {
      await ctx.report('compiling', 60);
      await h.service.assets.putExport(
        job.tenant,
        job.id,
        'output.pdf',
        Buffer.from('%PDF-1.7 revoke test'),
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

    async function completed(token: string, job: string) {
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        if (r.json?.state === 'completed') return r;
        await sleep(20);
      }
      throw new Error(`job ${job} did not complete`);
    }

    /** A refusal: an error status, and no signed URL and no job anywhere in the body. */
    function expectRefused(r: { status: number; text: string }, what: string) {
      expect([401, 403, 404], what).toContain(r.status);
      expect(r.text, what).not.toMatch(/"url"|output\.pdf|X-Amz|Signature=/);
    }

    it.skipIf(skip)(
      'after a document revocation, no new URL is issued and the issued URL keeps its expiry',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        // An editor's token from five seconds ago, so it predates the revocation watermark.
        const before = h.userToken(
          { [doc]: 'editor' },
          { sub: 'ruth', iat: Math.floor(h.now() / 1000) - 5 },
        );
        const job = (await post(doc, before)).json.id as string;
        const done = await completed(before, job);
        const url = done.json.result.url as string;
        const expiresAt = Date.parse(done.json.result.expiresAt as string);
        expect(typeof url).toBe('string');
        expect(Math.abs(expiresAt - (h.now() + FIVE_MINUTES))).toBeLessThanOrEqual(1000);

        const revoke = await h.call('POST', '/v1/sessions/revoke', {
          token: h.apiKey,
          body: { sub: 'ruth', doc },
        });
        expect(revoke.status).toBe(204);

        // The revoked token gets neither the job's result nor a new export.
        expectRefused(
          await h.call('GET', `/v1/exports/${job}`, { token: before }),
          'read after revocation',
        );
        expectRefused(await post(doc, before), 'new export after revocation');

        // The URL already issued is not withdrawn: its expiry is the one it was given, and it
        // passes at that expiry, not at the revocation.
        expect(expiresAt).toBeGreaterThan(h.now());
        h.advance(FIVE_MINUTES + 1000);
        expect(expiresAt).toBeLessThan(h.now());
      },
    );

    it.skipIf(skip)(
      'after a whole-user revocation, the revoked token gets no new URL',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const before = h.userToken(
          { [doc]: 'editor' },
          { sub: 'sam', iat: Math.floor(h.now() / 1000) - 5 },
        );
        const job = (await post(doc, before)).json.id as string;
        await completed(before, job);

        const revoke = await h.call('POST', '/v1/sessions/revoke', {
          token: h.apiKey,
          body: { sub: 'sam' },
        });
        expect(revoke.status).toBe(204);

        expectRefused(
          await h.call('GET', `/v1/exports/${job}`, { token: before }),
          'read after user revocation',
        );
        expectRefused(await post(doc, before), 'new export after user revocation');
      },
    );
  });
}
