// Export jobs over real HTTP (PRO-063, PRO-064; 09 §9.1; review SR-C4; D68, D69), with a stand-in
// for the compile worker of packet D registered as the `export` handler.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportOutputs } from '../../src/control-plane/handlers.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { objectKeys } from '../../src/objects/store.ts';
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

function withSuggestion(): Record<string, unknown> {
  const c = documentWithRegions() as {
    doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
  };
  c.doc.content[1]!.content[0]!.content = [
    { type: 'text', text: 'Hello' },
    {
      type: 'text',
      text: ' there',
      marks: [{ type: 'ins', attrs: { id: 'sSugg00000000001', user: 'alice' } }],
    },
  ];
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`export jobs over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let gate: (() => void) | null = null;
    const seen: Array<{ tenant: string; payload: Record<string, unknown> }> = [];
    const exportHandler: JobHandler = async (job, ctx) => {
      seen.push({ tenant: job.tenant, payload: job.payload });
      await ctx.report('converting', 10);
      if ((job.payload['options'] as { profile?: string }).profile === 'preview')
        await new Promise<void>((resolve) => (gate = resolve));
      await ctx.report('compiling', 60);
      // The worker writes under the job's prefix, with the tenant of the row (BE-049 criterion 5).
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
        'layout.json',
        Buffer.from('{}'),
        'application/json',
      );
      await h.service.assets.putExport(
        job.tenant,
        job.id,
        'compile.log',
        Buffer.from('log'),
        'text/plain',
      );
      const out: ExportOutputs = {
        output: 'output.pdf',
        pages: 1,
        layout: 'layout.json',
        converged: true,
        log: 'compile.log',
        diagnostics: [
          { severity: 'warning', code: 'overfull', blockId: null, message: 'An overfull line.' },
        ],
        imagesWithoutAlt: 2,
      };
      return out as unknown as Record<string, unknown>;
    };

    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      gate?.();
      await h?.close();
    });

    it.skipIf(skip)(
      'accepts an export with 202 and a job, and runs it to completion (PRO-063; PRO-064 criteria 1, 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const options = { profile: 'final', tagging: 'on', locale: 'en-GB' };
        const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: editor,
          body: { target: 'pdf', options },
        });
        expect(r.status).toBe(202);
        expect(r.headers.get('location')).toBe(`${h.base}/v1/exports/${r.json.id}`);
        expect(r.json).toMatchObject({
          doc,
          target: 'pdf',
          seq: 0,
          state: 'queued',
          progress: null,
          result: null,
          diagnostics: [],
        });
        const done = await until(h, editor, r.json.id, ['completed', 'failed']);
        expect(done.json.state).toBe('completed');
        expect(done.json.progress).toBe(100);
        expect(done.json.result).toMatchObject({ pages: 1, converged: true });
        // The count of pictures without alternative text the worker stored (EXP-113 criterion 2).
        expect(done.json.result.imagesWithoutAlt).toBe(2);
        expect(done.json.result.url).toContain(
          objectKeys
            .exportFile(h.tenant, r.json.id, 'output.pdf')
            .split('/')
            .map(encodeURIComponent)
            .join('/'),
        );
        expect(done.json.result.layout).toContain('layout.json');
        // The raw log goes to the requester while they have edit (09 §9.2; 07 §12).
        expect(done.json.result.log).toContain('compile.log');
        expect(new Date(done.json.result.expiresAt).getTime()).toBeGreaterThan(h.now());
        expect(done.json.diagnostics).toEqual([
          { severity: 'warning', code: 'overfull', blockId: null, message: 'An overfull line.' },
        ]);
        expect(done.headers.get('cache-control')).toBe('no-store');
        // Options reach the job unchanged (criterion 4), with the requester and their class (EXP-123).
        const job = seen.find((s) => (s.payload['doc'] as string) === doc)!;
        expect(job.tenant).toBe(h.tenant);
        expect(job.payload).toMatchObject({
          target: 'pdf',
          seq: 0,
          options,
          role: 'editor',
          hiddenRegions: [],
          hiddenValues: [],
        });
        expect(job.payload['view']).toBeTypeOf('string');
      },
    );

    it.skipIf(skip)(
      'refuses unsupported targets, seqs above the head, no-export callers and pending suggestions (PRO-063 criteria 2, 3; D68)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const post = (body: unknown, token = viewer) =>
          h.call('POST', `/v1/documents/${doc}/exports`, { token, body });
        expect((await post({ target: 'docx' })).json).toMatchObject({
          code: 'validation_failed',
          violations: [{ path: '/target' }],
        });
        expect((await post({ target: 'svg' })).json.code).toBe('validation_failed');
        expect((await post({ target: 'pdf', seq: 1 })).json).toMatchObject({
          code: 'validation_failed',
          violations: [{ path: '/seq' }],
        });
        const restricted = h.userToken({ [doc]: 'owner' }, { restrict: ['no-export'] });
        expect((await post({ target: 'pdf' }, restricted)).json.code).toBe('forbidden');
        expect((await post({ target: 'pdf' }, h.userToken({ [uuid7()]: 'owner' }))).status).toBe(
          403,
        );
        const suggested = await h.createDocument({ content: withSuggestion() });
        const t = h.userToken({ [suggested]: 'viewer' });
        const pending = await h.call('POST', `/v1/documents/${suggested}/exports`, {
          token: t,
          body: { target: 'pdf' },
        });
        expect(pending.status).toBe(409);
        expect(pending.json.code).toBe('pending_suggestions');
        const accepted = await h.call('POST', `/v1/documents/${suggested}/exports`, {
          token: t,
          body: { target: 'pdf', options: { suggestions: 'accept' } },
        });
        expect(accepted.status).toBe(202);
      },
    );

    it.skipIf(skip)(
      'gives a job, its result and its log to its requester only (review SR-C4; PRO-064 criterion 5; D69)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const other = await h.createDocument();
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'vera' });
        const job = (
          await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: viewer,
            body: { target: 'pdf' },
          })
        ).json.id as string;
        const done = await until(h, viewer, job, ['completed']);
        // A viewer requester gets no raw log.
        expect(done.json.result.log).toBeUndefined();
        // Another user whose token covers the document, even its owner, finds no such job (D69;
        // owner decision 57).
        expect(
          (
            await h.call('GET', `/v1/exports/${job}`, {
              token: h.userToken({ [doc]: 'owner' }, { sub: 'olga' }),
            })
          ).json.code,
        ).toBe('not_found');
        expect(
          (
            await h.call('DELETE', `/v1/exports/${job}`, {
              token: h.userToken({ [doc]: 'owner' }, { sub: 'olga' }),
            })
          ).json.code,
        ).toBe('not_found');
        // A token for another document finds no such job either (PRO-045 criterion 2).
        expect(
          (
            await h.call('GET', `/v1/exports/${job}`, {
              token: h.userToken({ [other]: 'owner' }, { sub: 'vera' }),
            })
          ).json.code,
        ).toBe('not_found');
        // The requester, once restricted with no-export, cannot download it.
        expect(
          (
            await h.call('GET', `/v1/exports/${job}`, {
              token: h.userToken({ [doc]: 'viewer' }, { sub: 'vera', restrict: ['no-export'] }),
            })
          ).json.code,
        ).toBe('forbidden');
        // A service credential of the tenant may read it; an unknown job is not_found.
        expect(
          (await h.call('GET', `/v1/exports/${job}`, { token: h.apiKey })).json.result.log,
        ).toContain('compile.log');
        expect((await h.call('GET', `/v1/exports/${uuid7()}`, { token: viewer })).json.code).toBe(
          'not_found',
        );
      },
    );

    it.skipIf(skip)(
      'cancels a running job, and leaves a finished one as it is (PRO-064 criterion 3; D68)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const job = (
          await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: editor,
            body: { target: 'pdf', options: { profile: 'preview' } },
          })
        ).json.id as string;
        const running = await until(h, editor, job, ['converting']);
        expect(running.json.progress).toBe(10);
        expect((await h.call('DELETE', `/v1/exports/${job}`, { token: editor })).status).toBe(204);
        expect((await h.call('GET', `/v1/exports/${job}`, { token: editor })).json.state).toBe(
          'cancelled',
        );
        gate?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The worker's late result is refused: the job stays cancelled.
        expect((await h.call('GET', `/v1/exports/${job}`, { token: editor })).json).toMatchObject({
          state: 'cancelled',
          result: null,
        });
        const second = (
          await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: editor,
            body: { target: 'pdf' },
          })
        ).json.id as string;
        await until(h, editor, second, ['completed']);
        expect((await h.call('DELETE', `/v1/exports/${second}`, { token: editor })).status).toBe(
          204,
        );
        expect((await h.call('GET', `/v1/exports/${second}`, { token: editor })).json.state).toBe(
          'completed',
        );
      },
    );
  });
}
