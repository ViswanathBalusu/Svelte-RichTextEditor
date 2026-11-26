// FRW-052 criterion 5 and FRW-053 on the live path (lane w4, 2026-11-18): nothing here calls
// `sealAndFinalise` by hand. The last participant completes, the service starts the final export
// job (pinned for a sealing export), the job's handler stands in for the compile worker (it stores
// a PDF and reports the pair of compile hashes), the export hook starts the seal step, the real
// signing service seals the PDF over HTTP (the key in this process, a test chain, a local OpenSSL
// time-stamp authority), and the workflow becomes `finalised` with `dep.workflow.finalised.v1`
// raised. A time-stamp authority that is down leaves the workflow `completed`, with an alert (an
// error log line and a counter); the scheduled step's function seals it when the authority is back.
// Memory storage and, when the test environment is up, PostgreSQL in Podman.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { verifyDetached, verifyWithOpenssl } from '../../../signing-service/test/support/verify.ts';
import { InProcessKeyService } from '../../../signing-service/test/support/world.ts';
import { objectKeys } from '../../src/objects/store.ts';
import { HttpSigningClient } from '../../src/workflow/signing-client.ts';
import {
  extendFinalised,
  sealedRenewalSigner,
  type ExtendDeps,
} from '../../src/workflow/extend-sealed.ts';
import { scheduleRenewals } from '../../src/workflow/renewal-schedule.ts';
import {
  RENEWAL_KIND,
  renewalHandler,
  renewalJobId,
} from '../../src/control-plane/jobs/workflow-renewal.ts';
import { verifySealedPdf } from '../../../signing-service/src/verify-sealed.ts';
import { MemoryAnchorStore } from '../../src/workflow/anchor-store.ts';
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
const SIGN_FIELD = 'ff00000000000154';
const INITIALS_FIELD = 'ff00000000000155';

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
  // A signature field the layout gives a rectangle, and an initials field it does not (FRW-057).
  for (const [id, key, kind] of [
    [SIGN_FIELD, 'tenant.sign', 'signature'],
    [INITIALS_FIELD, 'tenant.initials', 'initials'],
  ] as const)
    d.doc.content[1]!.content.push({
      type: 'paragraph',
      attrs: { id: `q${id.slice(1)}` },
      content: [
        {
          type: 'form_field',
          attrs: { id, key, kind, label: kind, assignee: 'tenant', required: false },
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

/** What the verification command prints, in the parts this test reads. */
interface Report {
  status: string;
  anchorMatches: boolean | null;
  evidence: { evidenceInChain: string[]; failedEvidence: string[] };
  seal: { ok: boolean; signatures: unknown[] };
}

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
    const anchors = new MemoryAnchorStore();
    const clients: DepClient[] = [];
    const input = classicPdf();
    const jobs: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const logged: LogFields[] = [];
    const sleeps: number[] = [];
    const client = () =>
      new HttpSigningClient({ url, credential: credential.current, timeoutMs: 120_000 });

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
        parts: { sealedPdfs: sealed, anchors },
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
            seal: (job) => client().seal(job),
            anchor: (job) => client().anchor(job),
            extend: (job) => client().extend(job),
          },
          retry: { attempts: 2, delaysMs: [10] },
          retainMs: RETAIN_MS,
          // A one-second lead: the service's own renewal job never finds an expiry due here; the
          // renewal test below runs the schedule and the handler itself.
          renewal: { leadMs: 1000, claimMs: 60_000 },
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
            // The layout of the compile: the signature field's box, 20 to 120 points across and 150
            // to 180 down a 200 by 200 point page, in twentieths of a point (09 section 7.1).
            await h.parts.objects.put(
              objectKeys.exportFile(job.tenant, job.id, 'layout.json'),
              new TextEncoder().encode(
                JSON.stringify({
                  seq: job.payload['seq'],
                  classVersion: '1.0.0',
                  granularity: 'block',
                  unit: 'twip',
                  pages: [],
                  blocks: {},
                  fields: { [SIGN_FIELD]: { page: 1, rect: [400, 3000, 2400, 3600] } },
                }),
              ),
            );
            const hash = sha256(input);
            return {
              output: 'output.pdf',
              pages: 1,
              layout: 'layout.json',
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

        // The chain head at completion is signed and time-stamped and written once (FRW-054).
        const anchored = await anchors.read(w.ref.tenant, w.doc, w.workflowId);
        expect(anchored).not.toBeNull();
        expect(JSON.parse(anchored!.record)).toEqual({
          chainHead: (job!.payload['sealing'] as { chainHead: string }).chainHead,
          document: w.doc,
          format: 'docedit-chain-head-anchor/1',
          seq: job!.payload['seq'],
          tenant: h.tenant,
          workflow: w.workflowId,
        });
        expect(anchored!.recordSha256).toBe(sha256(new TextEncoder().encode(anchored!.record)));
        const proof = verifyDetached(
          new Uint8Array(Buffer.from(anchored!.cms, 'base64')),
          new TextEncoder().encode(anchored!.record),
          pki,
        );
        expect(proof.main.ok, proof.main.detail).toBe(true);
        expect(proof.timestamp?.ok, proof.timestamp?.detail).toBe(true);

        // The route gives them back, and the event reached the host.
        const res = await fetch(`${h.base}/v1/documents/${w.doc}/workflow/final`, {
          headers: { authorization: `Bearer ${w.owner}` },
        });
        expect(res.status).toBe(200);
        expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(pdf));
        // The event is raised by the step that finalised, just after the state is stored.
        await waitFor('the finalised event', () =>
          h.events.of('dep.workflow.finalised.v1').some((e) => e.subject === w.doc),
        );
        expect(h.events.of('dep.workflow.completed.v1').some((e) => e.subject === w.doc)).toBe(
          true,
        );

        // FRW-036 criterion 1: `finalised` is raised once, with small data that holds the `seq` of the
        // control commit of the transition and the chain head, and nothing that names a person.
        const finals = h.events.of('dep.workflow.finalised.v1').filter((e) => e.subject === w.doc);
        expect(finals).toHaveLength(1);
        const data = finals[0]!.data as Record<string, unknown>;
        expect(Object.keys(data).sort()).toEqual(['chainHead', 'document', 'seq', 'workflow']);
        expect(data['workflow']).toBe(w.workflowId);
        expect(data['document']).toBe(w.doc);
        expect(Number.isSafeInteger(data['seq'])).toBe(true);
        expect(data['seq'] as number).toBeGreaterThan(job!.payload['seq'] as number);
        expect(data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
        const control = (await h.parts.logs.read(w.ref)).find((c) => c.seq === data['seq']);
        expect(control?.kind).toBe('control');
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
        // The chain head is signed first, so the run stops at the anchor, and nothing is written.
        expect(failed.map((f) => f.data['stage'])).toContain('anchor');
        expect(await anchors.read(w.ref.tenant, w.doc, w.workflowId)).toBeNull();

        // The authority is back: the scheduled step (the same function) seals it.
        authority.current = new HttpTimestampAuthority(tsa.url);
        const out = await h.service.sealer!.sealCompletedWorkflow(w.ref);
        expect(out.status).toBe('sealed');
        expect(await stateOf(w.ref)).toBe('finalised');
        expect(await anchors.read(w.ref.tenant, w.doc, w.workflowId)).not.toBeNull();
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
        expect(again).toEqual({ status: 'gave_up', code: 'wrong_caller' });
        expect(counter()).toBe(before + 1);
        credential.current = DOCUMENT_SERVICE_SECRET;
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'draws the appearances at the signature fields of the layout, reports the field with no rectangle, and the seal still validates (FRW-057)',
      async () => {
        authority.current = new HttpTimestampAuthority(tsa.url);
        credential.current = DOCUMENT_SERVICE_SECRET;
        const w = await complete();
        await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');
        const pdf = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
        const text = Buffer.from(pdf).toString('latin1');
        // The compile's bytes are the first bytes; the stamp follows, inside the rectangle of the layout.
        expect(Buffer.from(pdf.subarray(0, input.length)).equals(Buffer.from(input))).toBe(true);
        expect(text.match(/\/Subtype \/Stamp/g)).toHaveLength(1);
        expect(text).toContain('/Rect [20 20 120 50]');
        expect(text).toContain('(Not signed) Tj');
        // The seal is applied and covers the appearance.
        const reports = verifyWithOpenssl(pdf, pki);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
        expect((await verifySealedPdf(pdf, [pki.root])).ok).toBe(true);
        // The initials field has no rectangle: it is on record, and the seal went on. The entry is
        // written after the events of the finalisation, so the test waits for it.
        const diagnostics = () =>
          h.parts.audit!.query(h.tenant, {
            doc: w.doc,
            kind: 'workflow.appearance_diagnostics',
            limit: 5,
          });
        await waitFor('the diagnostics on record', async () => (await diagnostics()).length > 0);
        const entries = await diagnostics();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.data).toMatchObject({ workflow: w.workflowId, drawn: 1 });
        expect(JSON.parse(String(entries[0]!.data['diagnostics']))).toEqual([
          { id: INITIALS_FIELD, code: 'no_rectangle' },
        ]);
      },
      300_000,
    );
    it.skipIf(skip !== null)(
      'extends the sealed PDF of a finalised workflow for long-term validation and renews its time-stamp; the sealed object stays and /workflow/final returns the latest (FRW-056)',
      async () => {
        authority.current = new HttpTimestampAuthority(tsa.url);
        credential.current = DOCUMENT_SERVICE_SECRET;
        const w = await complete();
        await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');
        const original = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
        const seq = jobs.find((j) => j.payload['doc'] === w.doc)!.payload['seq'] as number;
        const deps: ExtendDeps = {
          workflows: h.parts.workflows!,
          sealed,
          signing: client(),
          now: () => Date.now(),
          retainMs: RETAIN_MS,
        };
        const ask = { tenant: w.ref.tenant, doc: w.doc, seq, idempotencyKey: `ltv-${w.doc}` };

        // Long-term validation data and a renewed time-stamp: a further object.
        const first = await extendFinalised(deps, { ...ask, validation: true });
        if (!first.ok) throw new Error(JSON.stringify(first));
        expect(first).toMatchObject({ n: 1, stored: true });
        const latest = (await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!;
        expect(latest.hash).toBe(first.hash);
        expect(latest.n).toBe(1);
        // The sealed object is stored byte for byte, and the update begins with it.
        expect(
          Buffer.from((await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes).equals(
            Buffer.from(original),
          ),
        ).toBe(true);
        expect(
          Buffer.from(latest.bytes.subarray(0, original.length)).equals(Buffer.from(original)),
        ).toBe(true);
        expect(latest.bytes.length).toBeGreaterThan(original.length);
        // The original signature still validates, and so does the whole file.
        const proof = verifyWithOpenssl(latest.bytes, pki);
        expect(proof.map((r) => r.signature.kind)).toEqual(['signature', 'document-time-stamp']);
        for (const r of proof) expect(r.main.ok, r.main.detail).toBe(true);
        expect((await verifySealedPdf(latest.bytes, [pki.root])).ok).toBe(true);
        // `/workflow/final` returns the latest, with its hash.
        const res = await fetch(`${h.base}/v1/documents/${w.doc}/workflow/final`, {
          headers: { authorization: `Bearer ${w.owner}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toBe(`"sha256:${first.hash}"`);
        expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(first.hash);

        // The same request again adds nothing; a new key renews once more, over the update.
        expect(await extendFinalised(deps, { ...ask, validation: true })).toMatchObject({
          ok: true,
          n: 1,
          stored: false,
        });
        const second = await extendFinalised(deps, {
          ...ask,
          idempotencyKey: `renew-${w.doc}`,
          validation: false,
        });
        expect(second).toMatchObject({ ok: true, n: 2, stored: true });
        const newest = (await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!;
        expect(
          Buffer.from(newest.bytes.subarray(0, latest.bytes.length)).equals(
            Buffer.from(latest.bytes),
          ),
        ).toBe(true);
        expect((await verifySealedPdf(newest.bytes, [pki.root])).ok).toBe(true);
        // An authority that is down gives no update and stores nothing.
        authority.current = { stamp: () => Promise.reject(new Error('authority down')) };
        expect(
          await extendFinalised(deps, {
            ...ask,
            idempotencyKey: `down-${w.doc}`,
            validation: false,
          }),
        ).toMatchObject({ ok: false, reason: 'tsa_unreachable', retryable: true });
        expect((await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!.n).toBe(2);
        authority.current = new HttpTimestampAuthority(tsa.url);
      },
      300_000,
    );
    it.skipIf(skip !== null)(
      'records the end of the seal time-stamp at finalisation, queues one renewal before it ends, and the renewal appends a further time-stamp (FRW-056 criterion 2)',
      async () => {
        authority.current = new HttpTimestampAuthority(tsa.url);
        credential.current = DOCUMENT_SERVICE_SECRET;
        const w = await complete();
        await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');
        const registry = h.parts.renewals!;

        // The first expiry was recorded by the finalisation itself: the authority certificate's end.
        await waitFor(
          'the first expiry',
          async () => (await registry.load(w.ref.tenant, w.doc)) !== null,
        );
        const first = (await registry.load(w.ref.tenant, w.doc))!.expiresAtMs;
        expect(first).toBeGreaterThan(Date.now());
        expect(await registry.start(w.ref.tenant, w.doc, first + 1)).toBe(false);
        expect((await registry.load(w.ref.tenant, w.doc))!.expiresAtMs).toBe(first);

        // Outside the lead time nothing is queued; inside it, one job for the expiry, however often.
        const outside = { registry, queue: h.parts.queue, leadMs: 1000, now: () => Date.now() };
        expect((await scheduleRenewals(outside, w.ref.tenant)).queued).toEqual([]);
        const inside = { ...outside, leadMs: first - Date.now() + 1000 };
        const queuedDocs = (await scheduleRenewals(inside, w.ref.tenant)).queued;
        expect(queuedDocs).toContainEqual({ doc: w.doc, expiresAtMs: first });
        await scheduleRenewals(inside, w.ref.tenant);
        const jobId = renewalJobId(w.doc, first);
        const job = (await h.parts.queue.get(w.ref.tenant, jobId))!;
        expect(job).toMatchObject({ kind: RENEWAL_KIND, doc: w.doc, payload: { expiry: first } });

        // The renewal appends a time-stamp over the sealed PDF. The test authority's certificate
        // does not change, so the signer reports a later end, as a rotated certificate would.
        const seq = jobs.find((j) => j.payload['doc'] === w.doc)!.payload['seq'] as number;
        const real = sealedRenewalSigner(
          {
            workflows: h.parts.workflows!,
            sealed,
            signing: client(),
            now: () => Date.now(),
            retainMs: RETAIN_MS,
          },
          async () => seq,
        );
        const YEAR = 365 * 24 * 3600 * 1000;
        const handler = renewalHandler({
          store: registry,
          signer: {
            renew: async (tenant, doc, expected, key) => {
              const out = await real.renew(tenant, doc, expected, key);
              return out.ok ? { ok: true, newExpiresAtMs: out.newExpiresAtMs + YEAR } : out;
            },
          },
          leadMs: inside.leadMs,
          claimMs: 60_000,
          now: () => Date.now(),
        });
        const ctx = undefined as never;
        expect(await handler(job, ctx)).toEqual({ renewed: true, expiresAtMs: first + YEAR });
        const latest = (await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!;
        expect(latest.n).toBe(1);
        const proof = verifyWithOpenssl(latest.bytes, pki);
        expect(proof.map((r) => r.signature.kind)).toEqual(['signature', 'document-time-stamp']);
        expect((await verifySealedPdf(latest.bytes, [pki.root])).ok).toBe(true);

        // The expiry has moved, so the document is not listed again: one time-stamp, one expiry.
        expect((await registry.load(w.ref.tenant, w.doc))!.expiresAtMs).toBe(first + YEAR);
        const after = (await scheduleRenewals(inside, w.ref.tenant)).queued;
        expect(after.find((d) => d.doc === w.doc)).toBeUndefined();
        expect((await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!.n).toBe(1);
      },
      300_000,
    );
    it.skipIf(skip !== null)(
      'a third party with only the bundle, the sealed PDF, the anchor file and the root verifies them with the command (FRW-055 criterion 2)',
      async () => {
        authority.current = new HttpTimestampAuthority(tsa.url);
        credential.current = DOCUMENT_SERVICE_SECRET;
        const w = await complete();
        await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');
        const bundle = await h.call('GET', `/v1/documents/${w.doc}/workflow/evidence`, {
          token: w.owner,
        });
        expect(bundle.status, bundle.text).toBe(200);
        const pdf = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
        const anchor = await anchors.read(w.ref.tenant, w.doc, w.workflowId);
        const dir = mkdtempSync(join(tmpdir(), 'frw055-'));
        try {
          const root = resolve(import.meta.dirname, '../../..', '..');
          const run = (bundleText: string, pdfBytes: Uint8Array) => {
            writeFileSync(join(dir, 'bundle.json'), bundleText);
            writeFileSync(join(dir, 'sealed.pdf'), pdfBytes);
            writeFileSync(join(dir, 'anchor.json'), JSON.stringify(anchor));
            const r = spawnSync(
              process.execPath,
              [
                'services/signing-service/scripts/verify-final.ts',
                join(dir, 'bundle.json'),
                join(dir, 'sealed.pdf'),
                '--root',
                pki.rootPem,
                '--anchor',
                join(dir, 'anchor.json'),
              ],
              { cwd: root, encoding: 'utf8', windowsHide: true },
            );
            return { code: r.status, report: JSON.parse(r.stdout) as Report };
          };
          const good = run(bundle.text, pdf);
          expect(good.code, JSON.stringify(good.report)).toBe(0);
          expect(good.report.status).toBe('intact');
          expect(good.report.anchorMatches).toBe(true);
          expect(good.report.evidence.evidenceInChain.length).toBeGreaterThan(0);
          expect(good.report.seal.signatures.length).toBeGreaterThan(0);

          // One byte of the sealed PDF changed: the seal is broken.
          const flipped = new Uint8Array(pdf);
          flipped[20] = (flipped[20] as number) ^ 1;
          const badPdf = run(bundle.text, flipped);
          expect(badPdf.code).toBe(1);
          expect(badPdf.report.seal.ok).toBe(false);

          // One evidence item changed: the item is named.
          const altered = JSON.parse(bundle.text);
          const item = altered.evidence.items[0];
          item.canonical = item.canonical.replace('"p1"', '"p2"');
          const badItem = run(JSON.stringify(altered), pdf);
          expect(badItem.code).toBe(1);
          expect(badItem.report.evidence.failedEvidence).toContain(item.id);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      300_000,
    );
  });
}
