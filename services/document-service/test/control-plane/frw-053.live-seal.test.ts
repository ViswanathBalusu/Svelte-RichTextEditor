// FRW-052 criterion 5 and FRW-053 on the live path (lane w4, 2026-11-18): nothing here calls
// `sealAndFinalise` by hand. The last participant completes, the service starts the final export
// job (pinned for a sealing export), the job's handler stands in for the compile worker (it stores
// a PDF and reports the pair of compile hashes), the export hook starts the seal step, the real
// signing service seals the PDF over HTTP (the key in this process, a test chain, a local OpenSSL
// time-stamp authority), and the workflow becomes `finalised` with `dep.workflow.finalised.v1`
// raised. A time-stamp authority that is down leaves the workflow `completed`, with an alert (an
// error log line and a counter); the scheduled step's function seals it when the authority is back.
// Memory storage and, when the test environment is up, PostgreSQL in Podman.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTimestampAuthority, type TimestampSource } from '../../../signing-service/src/cms.ts';
import { createSigningServer } from '../../../signing-service/src/http.ts';
import { classicPdf } from '../../../signing-service/test/support/classic-pdf.ts';
import {
  makePki,
  opensslAvailable,
  type TestPki,
} from '../../../signing-service/test/support/pki.ts';
import {
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  WORKER_SECRET,
} from '../../../signing-service/test/support/service-world.ts';
import { startTestTsa, type TestTsa } from '../../../signing-service/test/support/tsa.ts';
import { verifyWithOpenssl } from '../../../signing-service/test/support/verify.ts';
import { InProcessKeyService } from '../../../signing-service/test/support/world.ts';
import { objectKeys } from '../../src/objects/store.ts';
import { HttpSigningClient } from '../../src/workflow/signing-client.ts';
import { MemorySealedPdfStore } from '../../src/workflow/sealed-store.ts';
import type { LogFields } from '../../src/log.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const FIELD = 'ff00000000000153';

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFinal0000000153' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: FIELD,
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: 'Ada',
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c53',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const RETAIN_MS = 365 * 24 * 3600 * 1000;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the final PDF is sealed and the workflow finalised by the service itself (${storage}; FRW-052, FRW-053)`, async () => {
    const skip = (await skipReason(storage)) ?? (opensslAvailable() ? null : 'no openssl');
    let h: Harness;
    let pki: TestPki;
    let tsa: TestTsa;
    let ks: InProcessKeyService;
    let server: Server;
    let url = '';
    const authority: { current: TimestampSource } = {
      current: { stamp: () => Promise.reject(new Error('not started')) },
    };
    /** The credential the document service sends; a test may swap it. */
    const credential = { current: DOCUMENT_SERVICE_SECRET };
    const sealed = new MemorySealedPdfStore();
    const clients: DepClient[] = [];
    const input = classicPdf();
    const jobs: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const logged: LogFields[] = [];
    const sleeps: number[] = [];

    beforeAll(async () => {
      if (skip) return;
      ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      tsa = await startTestTsa(pki);
      authority.current = new HttpTimestampAuthority(tsa.url);
      const world = makeWorld({
        operator: { id: 'operator-key', keyService: ks, pki },
        tsaUrl: tsa.url,
        timestamps: { stamp: (d) => authority.current.stamp(d) },
      });
      server = createSigningServer(world.service, { maxBodyBytes: 5_000_000 });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      url = `http://127.0.0.1:${addr.port}`;
      h = await startHarness(storage, {
        realDataPlane: true,
        parts: { sealedPdfs: sealed },
        logger: {
          info() {},
          warn() {},
          error: (f) => {
            logged.push(f);
          },
        },
        finalSealing: {
          // The credential is read at each call, so that a test can send the worker's.
          signing: {
            seal: (job) =>
              new HttpSigningClient({
                url,
                credential: credential.current,
                timeoutMs: 120_000,
              }).seal(job),
          },
          retry: { attempts: 2, delaysMs: [10] },
          retainMs: RETAIN_MS,
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
        jobHandlers: {
          // The compile worker's place: store the PDF and report the pair of hashes it compared.
          export: async (job, ctx) => {
            await ctx.report('compiling', 50);
            jobs.push({ id: job.id, payload: job.payload });
            await h.parts.objects.put(
              objectKeys.exportFile(job.tenant, job.id, 'output.pdf'),
              input,
            );
            const hash = sha256(input);
            return {
              output: 'output.pdf',
              pages: 1,
              layout: null,
              converged: true,
              log: null,
              diagnostics: [],
              sealing: { pdfSha256: { a: hash, b: hash }, compileMs: [1, 1] },
            };
          },
        },
        config: { jobIdleMs: 20, jobRetryAfterMs: 10 },
      });
    }, 300_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      await tsa?.stop();
      pki?.remove();
    });

    /** Completes the only participant of a new workflow; the service does the rest. */
    async function complete() {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-153-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      expect(
        (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
      ).toBe(200);
      const tok = h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1', wfp: 'p1' });
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(tok)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const done = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
        token: tok,
        body: {},
      });
      expect(done.status, done.text).toBe(200);
      return { doc, owner, ref: { tenant: h.tenant, doc }, workflowId: done.json.id as string };
    }

    const stateOf = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.workflows!.read(ref.tenant, ref.doc))!.state;
    async function waitFor(what: string, ok: () => Promise<boolean> | boolean): Promise<void> {
      for (let i = 0; i < 300; i++) {
        if (await ok()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${what}`);
    }

    it.skipIf(skip !== null)(
      'finalises a completed workflow with no call from the test: the job is pinned, the PDF is sealed and stored, finalised is raised',
      async () => {
        authority.current = new HttpTimestampAuthority(tsa.url);
        credential.current = DOCUMENT_SERVICE_SECRET;
        const w = await complete();
        await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');

        // The job asked for a sealing export: the pin names `completedSeq` and a chain head.
        const job = jobs.find((j) => j.payload['doc'] === w.doc);
        expect(job).toBeDefined();
        expect(job!.payload['sealing']).toMatchObject({
          completedSeq: job!.payload['seq'],
          chainHead: expect.stringMatching(/^[0-9a-f]{64}$/),
        });

        // The sealed bytes are the input, then the seal; the seal and its time-stamp verify.
        const stored = await sealed.read(w.ref.tenant, w.doc, w.workflowId);
        expect(stored).not.toBeNull();
        const pdf = stored!.bytes;
        expect(Buffer.from(pdf.subarray(0, input.length)).equals(Buffer.from(input))).toBe(true);
        const reports = verifyWithOpenssl(pdf, pki);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
        expect(reports[0]!.timestamp?.ok, reports[0]!.timestamp?.detail).toBe(true);

        // The route gives them back, and the event reached the host.
        const res = await fetch(`${h.base}/v1/documents/${w.doc}/workflow/final`, {
          headers: { authorization: `Bearer ${w.owner}` },
        });
        expect(res.status).toBe(200);
        expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(pdf));
        expect(h.events.of('dep.workflow.finalised.v1').some((e) => e.subject === w.doc)).toBe(
          true,
        );
        expect(h.events.of('dep.workflow.completed.v1').some((e) => e.subject === w.doc)).toBe(
          true,
        );
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'a time-stamp authority that is down leaves the workflow completed and alerts the operator; the scheduled step seals it later',
      async () => {
        authority.current = { stamp: () => Promise.reject(new Error('authority down')) };
        credential.current = DOCUMENT_SERVICE_SECRET;
        sleeps.length = 0;
        logged.length = 0;
        const counter = () =>
          h.service.metrics.value('docedit_finalisation_stopped_total', {
            reason: 'tsa_unreachable',
            code: 'tsa_unreachable',
            retryable: 'true',
          });
        const before = counter();
        const w = await complete();
        await waitFor('the alert', () => counter() > before);

        // Waited and retried, then stopped: completed, nothing stored, no `finalised`.
        expect(sleeps).toContain(10);
        expect(await stateOf(w.ref)).toBe('completed');
        expect(await sealed.read(w.ref.tenant, w.doc, w.workflowId)).toBeNull();
        expect(
          (await h.call('GET', `/v1/documents/${w.doc}/workflow/final`, { token: w.owner })).status,
        ).toBe(404);
        expect(h.events.of('dep.workflow.finalised.v1').some((e) => e.subject === w.doc)).toBe(
          false,
        );
        // The operator's channel: an error line and a counter; the audit entry names the stop.
        expect(
          logged.some(
            (f) =>
              f.event === 'workflow.finalisation_stopped' &&
              f.doc === w.doc &&
              f.code === 'tsa_unreachable',
          ),
        ).toBe(true);
        const failed = await h.parts.audit!.query(h.tenant, {
          doc: w.doc,
          kind: 'workflow.finalisation_failed',
          limit: 10,
        });
        expect(failed.map((f) => f.data['stage'])).toContain('seal');

        // The authority is back: the scheduled step (the same function) seals it.
        authority.current = new HttpTimestampAuthority(tsa.url);
        const out = await h.service.sealer!.sealCompletedWorkflow(w.ref);
        expect(out.status).toBe('sealed');
        expect(await stateOf(w.ref)).toBe('finalised');
        expect(h.events.of('dep.workflow.finalised.v1').some((e) => e.subject === w.doc)).toBe(
          true,
        );
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'a request the signing service refuses is alerted once and is not asked again',
      async () => {
        authority.current = new HttpTimestampAuthority(tsa.url);
        credential.current = WORKER_SECRET;
        const counter = () =>
          h.service.metrics.value('docedit_finalisation_stopped_total', {
            reason: 'seal_failed',
            code: 'wrong_caller',
            retryable: 'false',
          });
        const before = counter();
        const w = await complete();
        await waitFor('the alert', () => counter() > before);
        expect(await stateOf(w.ref)).toBe('completed');
        const again = await h.service.sealer!.sealCompletedWorkflow(w.ref);
        expect(again).toEqual({ status: 'gave_up', code: 'seal_refused' });
        expect(counter()).toBe(before + 1);
        credential.current = DOCUMENT_SERVICE_SECRET;
      },
      300_000,
    );
  });
}
