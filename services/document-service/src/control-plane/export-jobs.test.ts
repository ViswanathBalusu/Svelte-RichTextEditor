// Export jobs: stages, notifications, options, the first-result cache and the preview window
// (EXP-004 to EXP-008). Runs over the control plane's HTTP surface with the in-memory data plane
// of the test harness; the compile worker of packet D is stood in for by a handler that writes
// a PDF under the job's prefix. The PostgreSQL run follows the other control-plane tests.
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  StubDataPlane,
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import { configFromEnv } from '../config.ts';
import { startService } from '../server.ts';
import { objectKeys } from '../objects/store.ts';
import type { DocRef } from '../storage/types.ts';
import { EXPORT_KIND, PREVIEW_KIND, exportRequestKey } from './exports.ts';
import { checkQueueProof, QUEUE_PROOF_MEMBER } from './job-proof.ts';
import { signJws } from './jwt.ts';
import { JobFailure, type JobHandler } from './jobs/runner.ts';
import { MemoryJobQueue } from './jobs/queue.ts';
import { signingKey } from './tokens.ts';
import { startOnFetchablePort } from '../../test/support/ports.ts';

const DAY = 24 * 60 * 60 * 1000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `fn` until it returns a value; the answer must come within about four seconds. */
async function waitFor<T>(fn: () => T | undefined | null | false): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('the condition was not met in time');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`export jobs (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** The jobs the handler ran, with the options each received. */
    const ran: Array<{ id: string; options: Record<string, unknown> }> = [];
    /** When set, preview jobs wait at the `converting` stage until `release` is called. */
    let holdPreview = false;
    let gate: (() => void) | null = null;
    let failNext = false;

    const exportHandler: JobHandler = async (job, ctx) => {
      const options = job.payload['options'] as Record<string, unknown>;
      ran.push({ id: job.id, options });
      await ctx.report('converting', 10);
      if (failNext) {
        failNext = false;
        throw new JobFailure('compile_failed', 'The document did not compile.');
      }
      if (holdPreview && options['profile'] === 'preview')
        await new Promise<void>((resolve) => (gate = resolve));
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

    const release = () => {
      holdPreview = false;
      gate?.();
      gate = null;
    };

    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      release();
      await h?.close();
    });

    /** The notifications the control plane sent for one export job. */
    const notes = (job: string, type?: string) =>
      h.stub.notices.filter(
        (n) =>
          n.kind === 'notify' &&
          n.notification?.resource === `/exports/${job}` &&
          (type === undefined || n.notification.type === type),
      );

    /** Polls the API until the job reaches one of `states`. */
    async function reach(token: string, job: string, states: string[]) {
      let last: unknown = null;
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        last = r.json;
        if (states.includes(r.json?.state)) return r;
        await sleep(20);
      }
      throw new Error(
        `job ${job} did not reach ${states.join(' or ')}; last ${JSON.stringify(last)}`,
      );
    }

    const post = (doc: string, token: string, options?: Record<string, unknown>) =>
      h.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        body: options === undefined ? { target: 'pdf' } : { target: 'pdf', options },
      });

    it.skipIf(skip)(
      'sends each stage as export.progress and raises export.completed and its webhook (EXP-004 criteria 2, 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const id = (await post(doc, editor, { profile: 'final' })).json.id as string;
        await reach(editor, id, ['completed']);
        const stages = await waitFor(() => {
          const s = notes(id, 'export.progress').map((n) => n.notification?.data?.['state']);
          return s.length >= 3 ? s : undefined;
        });
        expect(stages).toEqual(['queued', 'converting', 'compiling']);
        await waitFor(() => notes(id, 'export.completed')[0]);
        expect(notes(id, 'export.completed')[0]!.notification!.data).toEqual({
          state: 'completed',
        });
        const webhook = await waitFor(() =>
          h.events.of('dep.export.completed.v1').find((e) => e.data['job'] === id),
        );
        expect(webhook).toMatchObject({
          tenant: h.tenant,
          subject: doc,
          data: { seq: 0, job: id },
        });
      },
    );

    it.skipIf(skip)(
      'raises export.failed and its webhook when a compile fails for good (EXP-004 criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        failNext = true;
        const id = (await post(doc, editor, { profile: 'final', tagging: 'draft' })).json
          .id as string;
        const done = await reach(editor, id, ['completed', 'failed']);
        expect(done.json.state).toBe('failed');
        const failed = await waitFor(() => notes(id, 'export.failed')[0]);
        expect(failed.notification!.data).toEqual({ state: 'failed', code: 'compile_failed' });
        const webhook = await waitFor(() =>
          h.events.of('dep.export.failed.v1').find((e) => e.data['job'] === id),
        );
        expect(webhook.data).toMatchObject({ seq: 0, code: 'compile_failed' });
      },
    );

    it.skipIf(skip)(
      'raises export.cancelled when a running job is cancelled (EXP-004 criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        holdPreview = true;
        const id = (await post(doc, editor, { profile: 'preview' })).json.id as string;
        await reach(editor, id, ['converting']);
        expect((await h.call('DELETE', `/v1/exports/${id}`, { token: editor })).status).toBe(204);
        await waitFor(() => notes(id, 'export.cancelled')[0]);
        expect((await h.call('GET', `/v1/exports/${id}`, { token: editor })).json.state).toBe(
          'cancelled',
        );
        release();
      },
    );

    it.skipIf(skip)(
      'refuses option values outside the published schema and records the default of fields (EXP-005 criteria 1, 2, 3, 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const refused = [
          { profile: 'draft' },
          { tagging: 'maybe' },
          { pdfStandard: 'x-9' },
          { fields: 'other' },
          { locale: 'not a locale' },
          { certificate: 'yes' },
        ];
        for (const options of refused) {
          const r = await post(doc, editor, options);
          expect(r.status, JSON.stringify(options)).toBe(400);
          expect(r.json.code, JSON.stringify(options)).toBe('validation_failed');
        }
        const accepted = [
          { profile: 'final', tagging: 'on', pdfStandard: 'ua-2' },
          { profile: 'final', tagging: 'draft', pdfStandard: 'a-4', fields: 'blank' },
          { profile: 'final', tagging: 'off', locale: 'en-GB', timeZone: 'Europe/London' },
        ];
        for (const options of accepted) {
          const r = await post(doc, editor, options);
          expect(r.status, JSON.stringify(options)).toBe(202);
          await reach(editor, r.json.id, ['completed']);
        }
        // A request without `fields` runs with `flatten`, the published default.
        const plain = (
          await post(doc, editor, { profile: 'final', tagging: 'on', locale: 'fr-FR' })
        ).json.id as string;
        await reach(editor, plain, ['completed']);
        expect(ran.find((r) => r.id === plain)!.options['fields']).toBe('flatten');
      },
    );

    it.skipIf(skip)(
      'answers an identical request from the first result and compiles each different request (EXP-006 criteria 1, 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const options = { profile: 'final', tagging: 'on' };
        const first = (await post(doc, editor, options)).json.id as string;
        await reach(editor, first, ['completed']);
        const before = ran.length;
        const again = await post(doc, editor, options);
        expect(again.status).toBe(202);
        expect(again.json.id).not.toBe(first);
        expect(again.json.state).toBe('completed');
        expect(again.json.result.url).toContain(
          objectKeys
            .exportFile(h.tenant, first, 'output.pdf')
            .split('/')
            .map(encodeURIComponent)
            .join('/'),
        );
        expect(ran.length).toBe(before);
        // The same bundle as a preview is a different request: it compiles again.
        const preview = (await post(doc, editor, { ...options, profile: 'preview' })).json
          .id as string;
        await reach(editor, preview, ['completed']);
        expect(ran.length).toBe(before + 1);
        // A different option is a different bundle.
        const other = (await post(doc, editor, { ...options, tagging: 'draft' })).json.id as string;
        await reach(editor, other, ['completed']);
        expect(ran.length).toBe(before + 2);
        // And the preview's repeat is answered from its own first result (EXP-008 criterion 3).
        const repeat = await post(doc, editor, { ...options, profile: 'preview' });
        expect(repeat.json.state).toBe('completed');
        expect(ran.length).toBe(before + 2);
      },
    );

    it.skipIf(skip)(
      'compiles again when the classification label changed, and answers from the first result when it did not (EXP-089 criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const setLabel = async (classification: string | null) => {
          const etag = (
            await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })
          ).headers.get('etag')!;
          const r = await h.call('PATCH', `/v1/documents/${doc}`, {
            token: h.apiKey,
            body: { classification },
            headers: { 'If-Match': etag },
          });
          expect(r.status).toBe(200);
        };
        const options = { profile: 'final' };
        await setLabel('Internal');
        const first = (await post(doc, editor, options)).json.id as string;
        await reach(editor, first, ['completed']);
        const before = ran.length;
        // Same content, same label: the first result answers.
        const same = await post(doc, editor, options);
        expect(same.json.state).toBe('completed');
        expect(ran.length).toBe(before);
        // Another label with the same content is another request: a new job compiles.
        await setLabel('Secret');
        const changed = (await post(doc, editor, options)).json.id as string;
        await reach(editor, changed, ['completed']);
        expect(ran.length).toBe(before + 1);
        const read = await h.call('GET', `/v1/exports/${changed}`, { token: editor });
        expect(read.json.result.url).toContain(
          objectKeys
            .exportFile(h.tenant, changed, 'output.pdf')
            .split('/')
            .map(encodeURIComponent)
            .join('/'),
        );
        // Removing the label is a change too, and the unlabelled request has its own result.
        await setLabel(null);
        const cleared = (await post(doc, editor, options)).json.id as string;
        await reach(editor, cleared, ['completed']);
        expect(ran.length).toBe(before + 2);
      },
    );

    it.skipIf(skip)(
      'cancels a queued preview when its viewer closes it, and holds later previews inside the window (EXP-008 criteria 2, 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const other = h.userToken({ [doc]: 'editor' }, { sub: 'eva' });
        holdPreview = true;
        const first = (await post(doc, editor, { profile: 'preview', tagging: 'draft' })).json
          .id as string;
        await reach(editor, first, ['converting']);
        // A second requester's preview in the same window starts only after the window (BE-051).
        const second = await post(doc, other, { profile: 'preview', tagging: 'off' });
        expect(second.json.state).toBe('queued');
        expect(
          (await h.call('DELETE', `/v1/exports/${second.json.id}`, { token: other })).status,
        ).toBe(204);
        expect(
          (await h.call('GET', `/v1/exports/${second.json.id}`, { token: other })).json.state,
        ).toBe('cancelled');
        const third = (await post(doc, other, { profile: 'preview', tagging: 'on' })).json
          .id as string;
        release();
        await reach(editor, first, ['completed']);
        await sleep(150);
        expect((await h.call('GET', `/v1/exports/${third}`, { token: other })).json.state).toBe(
          'queued',
        );
        h.advance(10_001);
        await reach(other, third, ['completed']);
      },
    );

    it.skipIf(skip)(
      'starts one preview compile of a document per window, however many viewers wait (EXP-008 criterion 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const first = h.userToken({ [doc]: 'editor' });
        const second = h.userToken({ [doc]: 'editor' }, { sub: 'eva' });
        const third = h.userToken({ [doc]: 'editor' }, { sub: 'max' });
        holdPreview = true;
        const before = ran.length;
        const one = (await post(doc, first, { profile: 'preview', tagging: 'draft' })).json
          .id as string;
        await reach(first, one, ['converting']);
        // Two more viewers ask for previews of their own while the first compiles. Each is held by
        // the request rule until a window after the preview asked for before it, which for both is
        // about ten seconds from now.
        const two = (await post(doc, second, { profile: 'preview', tagging: 'off' })).json
          .id as string;
        const three = (await post(doc, third, { profile: 'preview', tagging: 'on' })).json
          .id as string;
        release();
        await reach(first, one, ['completed']);
        expect(ran.length).toBe(before + 1);
        // The window passes. Both waiting previews are due by the time they were asked for, and
        // only one of them starts: the other waits a window after that start.
        h.advance(10_001);
        await waitFor(() => ran.length >= before + 2);
        await sleep(300);
        expect(ran.length).toBe(before + 2);
        const states = async () => [
          (await h.call('GET', `/v1/exports/${two}`, { token: second })).json.state as string,
          (await h.call('GET', `/v1/exports/${three}`, { token: third })).json.state as string,
        ];
        let seen: string[] = [];
        for (let i = 0; i < 200 && !seen.includes('completed'); i++) {
          await sleep(20);
          seen = await states();
        }
        expect([...seen].sort()).toEqual(['completed', 'queued']);
        // After another window the last one compiles too.
        h.advance(10_001);
        await reach(second, two, ['completed']);
        await reach(third, three, ['completed']);
        expect(ran.length).toBe(before + 3);
        // The starts the queue recorded are a window apart, in its own clock (for PostgreSQL the
        // harness has moved the earlier starts back with the clock, as it does every job time).
        const starts = (
          await Promise.all([one, two, three].map((id) => h.parts.queue.get(h.tenant, id)))
        )
          .map((j) => j!.startedAt!)
          .sort((x, y) => x - y);
        expect(starts).toHaveLength(3);
        for (let i = 1; i < starts.length; i++)
          expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(10_000);
      },
    );

    it.skipIf(skip)(
      'starts no second preview compile while the window runs, and answers the same request with the pending job (BE-051 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        holdPreview = true;
        const before = ran.length;
        const first = (await post(doc, editor, { profile: 'preview', tagging: 'draft' })).json
          .id as string;
        await reach(editor, first, ['converting']);
        // The same request, inside the window and while the first compile runs: the pending job.
        const same = await post(doc, editor, { profile: 'preview', tagging: 'draft' });
        expect(same.status).toBe(202);
        expect(same.json.id).toBe(first);
        // A different preview of the same document waits for the window: it is queued, not run.
        const other = (await post(doc, editor, { profile: 'preview', tagging: 'on' })).json
          .id as string;
        expect(other).not.toBe(first);
        await sleep(100);
        expect(ran.length).toBe(before + 1);
        expect((await h.call('GET', `/v1/exports/${other}`, { token: editor })).json.state).toBe(
          'queued',
        );
        release();
        await reach(editor, first, ['completed']);
        await sleep(150);
        // Still inside the window: the second compile has not started.
        expect(ran.length).toBe(before + 1);
        expect((await h.call('GET', `/v1/exports/${other}`, { token: editor })).json.state).toBe(
          'queued',
        );
        // After the window the queued preview compiles, and only then.
        h.advance(10_001);
        await reach(editor, other, ['completed']);
        expect(ran.length).toBe(before + 2);
      },
    );

    it.skipIf(skip)(
      'issues a fresh signed URL when a cached result is requested after its URL expired (EXP-006 criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const options = { profile: 'final', tagging: 'on', locale: 'de-DE' };
        const first = (await post(doc, editor, options)).json.id as string;
        const done = await reach(editor, first, ['completed']);
        const oldExpiry = Date.parse(done.json.result.expiresAt);
        const oldUrl = done.json.result.url as string;
        // Tokens live ten minutes, so the later requests use a token minted after the advance.
        h.advance(DAY);
        const later = h.userToken({ [doc]: 'editor' });
        const before = ran.length;
        const cached = await post(doc, later, options);
        expect(cached.json.state).toBe('completed');
        expect(ran.length).toBe(before);
        expect(Date.parse(cached.json.result.expiresAt)).toBeGreaterThan(oldExpiry);
        expect(Date.parse(cached.json.result.expiresAt)).toBeGreaterThan(h.now());
        expect(cached.json.result.url).not.toBe(oldUrl);
        // The same result read again later is signed afresh too.
        const read = await h.call('GET', `/v1/exports/${cached.json.id}`, { token: later });
        expect(Date.parse(read.json.result.expiresAt)).toBeGreaterThan(h.now());
      },
    );

    it.skipIf(skip)(
      'starts no preview compile when the document changes and nobody asks for one (EXP-008 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        // A commit of two characters into the intro paragraph, appended as the commit route's
        // data plane does (routes.commits.test.ts), with nobody's preview open.
        const ref: DocRef = { tenant: h.tenant, doc };
        const epoch = await h.parts.ownership.claim(ref, 'test-node');
        const head = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const handled = ran.length;
        const at = introPosition();
        const commit: StoredCommit = {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps',
          steps: [
            {
              stepType: 'replace',
              from: at,
              to: at,
              slice: { content: [{ type: 'text', text: 'hi' }] },
            },
          ] as StoredCommit['steps'],
          user: 'editor',
          session: 'session-export-idle',
          time: h.now(),
          origin: 'input',
          scopes: ['body'],
          revision: perms.revision,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
        };
        const appended = await h.parts.logs.append(ref, {
          epoch,
          revision: perms.revision,
          fromSeq: head.seq + 1,
          commits: [commit],
        });
        expect(appended.status).toBe('ok');
        await sleep(200);
        expect(await h.parts.queue.latestFor(h.tenant, doc, PREVIEW_KIND)).toBeNull();
        expect(ran.slice(handled).some((j) => j.options['profile'] === 'preview')).toBe(false);
        // The control: a preview asked for by a viewer is queued, so the check above can see one.
        const asked = await post(doc, editor, { profile: 'preview' });
        expect(asked.status).toBe(202);
        expect(await h.parts.queue.latestFor(h.tenant, doc, PREVIEW_KIND)).not.toBeNull();
        await reach(editor, asked.json.id as string, ['completed']);
      },
    );

    it.skipIf(skip)(
      'starts no compile of any kind when a document changes and page-break reconciliation is off for the tenant (EXP-008 criterion 5)',
      async () => {
        expect(await h.parts.tenantSettings!.pageBreakReconciliation(h.tenant)).toBe(false);
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        // The same commit of two characters as criterion 1, with the tenant's setting off.
        const ref: DocRef = { tenant: h.tenant, doc };
        const epoch = await h.parts.ownership.claim(ref, 'test-node');
        const head = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const handled = ran.length;
        const at = introPosition();
        const commit: StoredCommit = {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps',
          steps: [
            {
              stepType: 'replace',
              from: at,
              to: at,
              slice: { content: [{ type: 'text', text: 'hi' }] },
            },
          ] as StoredCommit['steps'],
          user: 'editor',
          session: 'session-export-reconcile-off',
          time: h.now(),
          origin: 'input',
          scopes: ['body'],
          revision: perms.revision,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
        };
        const appended = await h.parts.logs.append(ref, {
          epoch,
          revision: perms.revision,
          fromSeq: head.seq + 1,
          commits: [commit],
        });
        expect(appended.status).toBe('ok');
        await sleep(200);
        expect(await h.parts.queue.latestFor(h.tenant, doc, PREVIEW_KIND)).toBeNull();
        expect(await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND)).toBeNull();
        expect(ran.length).toBe(handled);
        // A line-level compile, the kind reconciliation would start, is refused while it is off.
        const lines = await post(doc, editor, { profile: 'preview', layout: 'lines' });
        expect(lines.status).toBe(403);
        await sleep(200);
        expect(ran.length).toBe(handled);
        expect(await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND)).toBeNull();
      },
    );

    it.skipIf(skip || storage !== 'memory')(
      'compiles again under another house class version and answers the same version from the first result (EXP-006 criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const options = { profile: 'final', tagging: 'on' };
        const first = (await post(doc, editor, options)).json.id as string;
        await reach(editor, first, ['completed']);
        const firstKey = (await h.parts.queue.get(h.tenant, first))?.cacheKey;
        // A second service over the same stores, running under another house class version. The
        // class version is part of the request key, so the same request must compile again there.
        const other = await startOnFetchablePort(
          () =>
            startService({
              config: {
                ...configFromEnv({}),
                port: 0,
                workers: 1,
                jobIdleMs: 20,
                jobLeaseMs: 2000,
                exportClassVersion: 'class-2099.1',
              },
              parts: h.parts,
              createDataPlane: () => new StubDataPlane(),
              jobHandlers: { export: exportHandler },
              signing: signingKey(undefined, 'service-test'),
              now: () => h.now(),
            }),
          (s) => s.url,
          (s) => s.close(),
        );
        try {
          const iat = Math.floor(h.now() / 1000);
          const token = signJws(
            { alg: h.host.alg, typ: 'JWT', kid: h.host.kid },
            {
              iss: 'https://host.example.test',
              aud: other.url,
              iat,
              exp: iat + 600,
              jti: uuid7(),
              tid: h.tenant,
              sub: 'alice',
              docs: { [doc]: 'editor' },
            },
            h.host.privateKey,
          );
          const before = ran.length;
          const res = await fetch(`${other.url}/v1/documents/${doc}/exports`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'pdf', options }),
          });
          expect(res.status).toBe(202);
          const second = ((await res.json()) as { id: string }).id;
          await reach(editor, second, ['completed']);
          expect(ran.length).toBe(before + 1);
          const secondKey = (await h.parts.queue.get(h.tenant, second))?.cacheKey;
          expect(secondKey).toBeDefined();
          expect(secondKey).not.toBe(firstKey);
          // The control: the first service still answers the first request from its result.
          const hit = await post(doc, editor, options);
          expect(hit.json.state).toBe('completed');
          expect(ran.length).toBe(before + 1);
        } finally {
          await other.close();
        }
      },
    );

    it.skipIf(skip || storage !== 'memory')(
      'writes the queue proof into the payload of every job when a proof key is set (EXP-067 criterion 4)',
      async () => {
        const key = 'p'.repeat(40);
        const doc = await h.createDocument({ content: documentWithRegions() });
        const other = await startOnFetchablePort(
          () =>
            startService({
              config: {
                ...configFromEnv({}),
                port: 0,
                workers: 1,
                jobIdleMs: 20,
                jobLeaseMs: 2000,
                exportProofKey: key,
              },
              parts: h.parts,
              createDataPlane: () => new StubDataPlane(),
              jobHandlers: { export: exportHandler },
              signing: signingKey(undefined, 'service-test'),
              now: () => h.now(),
            }),
          (s) => s.url,
          (s) => s.close(),
        );
        try {
          const iat = Math.floor(h.now() / 1000);
          const token = signJws(
            { alg: h.host.alg, typ: 'JWT', kid: h.host.kid },
            {
              iss: 'https://host.example.test',
              aud: other.url,
              iat,
              exp: iat + 600,
              jti: uuid7(),
              tid: h.tenant,
              sub: 'alice',
              docs: { [doc]: 'editor' },
            },
            h.host.privateKey,
          );
          const res = await fetch(`${other.url}/v1/documents/${doc}/exports`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'pdf', options: { profile: 'final' } }),
          });
          expect(res.status).toBe(202);
          const id = ((await res.json()) as { id: string }).id;
          const job = (await h.parts.queue.get(h.tenant, id))!;
          const subject = {
            tenant: job.tenant,
            kind: job.kind,
            doc: job.doc,
            cacheKey: job.cacheKey,
          };
          expect(typeof job.payload[QUEUE_PROOF_MEMBER]).toBe('string');
          expect(checkQueueProof(key, subject, job.payload)).toBe(true);
          // Another key, another document, or a changed payload does not verify.
          expect(checkQueueProof('q'.repeat(40), subject, job.payload)).toBe(false);
          expect(checkQueueProof(key, { ...subject, doc: uuid7() }, job.payload)).toBe(false);
          expect(checkQueueProof(key, subject, { ...job.payload, seq: 99 })).toBe(false);
        } finally {
          await other.close();
        }
      },
    );
  });
}

/** The position just inside the intro paragraph of documentWithRegions (routes.commits.test.ts). */
function introPosition(): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(documentWithRegions()['doc'])
    .descendants((n, pos) => {
      if (n.attrs['id'] === 'pIntro0000000001') at = pos + 1;
      return at < 0;
    });
  return at;
}

describe('export requests and the first-result cache, without a service', () => {
  it('never returns a cached result to another tenant (EXP-006 criterion 5)', async () => {
    const queue = new MemoryJobQueue(() => 1_000);
    await queue.enqueue('tenant-a', {
      kind: 'export',
      doc: 'doc-1',
      createdBy: 'someone',
      payload: {},
      cacheKey: 'ab'.repeat(32),
      completedWith: { output: 'output.pdf' },
    });
    expect(await queue.findCompleted('tenant-a', 'ab'.repeat(32), 0)).not.toBeNull();
    expect(await queue.findCompleted('tenant-b', 'ab'.repeat(32), 0)).toBeNull();
  });

  it('keys each request by its tenant, document, content, options and house class version (EXP-006 criteria 2, 3, 5)', () => {
    const base = {
      tenant: 't1',
      doc: 'd1',
      incarnation: 'i1',
      seq: 3,
      view: 'v1',
      target: 'pdf',
      options: { profile: 'final' },
      full: false,
      classVersion: '1.0.0',
    };
    const key = exportRequestKey(base);
    expect(exportRequestKey({ ...base })).toBe(key);
    expect(exportRequestKey({ ...base, tenant: 't2' })).not.toBe(key);
    expect(exportRequestKey({ ...base, options: { profile: 'preview' } })).not.toBe(key);
    expect(exportRequestKey({ ...base, classVersion: '1.0.1' })).not.toBe(key);
    expect(exportRequestKey({ ...base, seq: 4 })).not.toBe(key);
    expect(exportRequestKey({ ...base, doc: uuid7() })).not.toBe(key);
  });
});
