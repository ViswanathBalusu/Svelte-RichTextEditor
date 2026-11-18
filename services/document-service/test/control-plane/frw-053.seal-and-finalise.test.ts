// FRW-052 criterion 5 and FRW-053 through the real document service and the real signing service
// (over HTTP on the loopback interface, the key held in this process, a test chain and a local
// OpenSSL time-stamp authority): a completed workflow is sealed with a time-stamp and finalised;
// a time-stamp authority that does not answer gives no seal, the workflow stays `completed`, the run
// is retried and then stops with an audit entry and an operator alert; a refused request is not
// retried; the seal's time is the token's and every other time is the server's.
// The signing service's own rules are in services/signing-service/test/frw-052-service.test.ts.
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
import {
  cmsParts,
  findSignatures,
  verifyWithOpenssl,
} from '../../../signing-service/test/support/verify.ts';
import { InProcessKeyService } from '../../../signing-service/test/support/world.ts';
import { HttpSigningClient } from '../../src/workflow/signing-client.ts';
import {
  sealAndFinalise,
  type OperatorAlert,
  type SealAndFinaliseDeps,
} from '../../src/workflow/seal-and-finalise.ts';
import { MemorySealedPdfStore } from '../../src/workflow/sealed-store.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const FIELD = 'ff00000000000053';

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
    attrs: { id: 'pFinal0000000053' },
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

const body = (doc: string, finalisation?: Record<string, unknown>) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c53',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
  ...(finalisation ? { finalisation } : {}),
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const RETAIN = Date.UTC(2040, 0, 1);
/** The server clock for the transition: an hour before now, so that it is not the authority's time (the audit partitions cover the present). */
const SERVER_NOW = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;

/** Fails the first `failures` requests as an authority that is down, then answers. */
class Flaky implements TimestampSource {
  calls = 0;
  readonly #failures: number;
  readonly #inner: TimestampSource;
  constructor(failures: number, inner: TimestampSource) {
    this.#failures = failures;
    this.#inner = inner;
  }
  stamp(digest: Uint8Array): Promise<Uint8Array> {
    this.calls += 1;
    if (this.calls <= this.#failures) return Promise.reject(new Error('authority down'));
    return this.#inner.stamp(digest);
  }
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`sealing and finalising a workflow through the signing service (${storage}; FRW-052, FRW-053)`, async () => {
    const skip = (await skipReason(storage)) ?? (opensslAvailable() ? null : 'no openssl');
    let h: Harness;
    let pki: TestPki;
    let tsa: TestTsa;
    let ks: InProcessKeyService;
    let server: Server;
    let url = '';
    let timestamps: TimestampSource;
    /** The authority behind one indirection, so that a test can make it fail. */
    const authority: { current: TimestampSource } = {
      current: { stamp: () => Promise.reject(new Error('not started')) },
    };
    let signingAudit: ReturnType<typeof makeWorld>['audit'];
    const sealed = new MemorySealedPdfStore();
    const clients: DepClient[] = [];
    const input = classicPdf();
    let nextSeq = 1;

    beforeAll(async () => {
      if (skip) return;
      ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      tsa = await startTestTsa(pki);
      authority.current = new HttpTimestampAuthority(tsa.url);
      timestamps = { stamp: (d) => authority.current.stamp(d) };
      const world = makeWorld({
        operator: { id: 'operator-key', keyService: ks, pki },
        tsaUrl: tsa.url,
        timestamps,
      });
      signingAudit = world.audit;
      server = createSigningServer(world.service, { maxBodyBytes: 5_000_000 });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      url = `http://127.0.0.1:${addr.port}`;
      h = await startHarness(storage, {
        realDataPlane: true,
        parts: { sealedPdfs: sealed },
        jobHandlers: {
          export: async (_job, ctx) => {
            await ctx.report('converting', 10);
            return {
              output: 'output.pdf',
              pages: 1,
              layout: null,
              converged: true,
              log: null,
              diagnostics: [],
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

    const gate = () => authority;

    const alerts: OperatorAlert[] = [];
    const sleeps: number[] = [];
    const deps = (credential = DOCUMENT_SERVICE_SECRET, attempts = 3): SealAndFinaliseDeps => ({
      workflows: h.parts.workflows!,
      grants: h.parts.grants,
      logs: h.parts.logs,
      notifier: h.service.dataPlane,
      audit: h.parts.audit,
      now: () => SERVER_NOW,
      controlWaitMs: 5000,
      sealed,
      signing: new HttpSigningClient({ url, credential, timeoutMs: 120_000 }),
      alert: (a) => {
        alerts.push(a);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      retry: { attempts, delaysMs: [10, 20] },
    });

    /** A workflow whose only participant has completed, so that it is `completed`. */
    async function completed(finalisation?: Record<string, unknown>) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-053-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc, finalisation),
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
      expect(done.json.state).toBe('completed');
      return { doc, owner, ref: { tenant: h.tenant, doc }, workflowId: done.json.id as string };
    }

    const stateOf = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.workflows!.read(ref.tenant, ref.doc))!.state;
    const request = (ref: { tenant: string; doc: string }) => ({
      ref,
      actor: 'system',
      pdf: input,
      compileSha256: [sha256(input), sha256(input)] as [string, string],
      seq: nextSeq++,
      retainUntilMs: RETAIN,
    });

    it.skipIf(skip !== null)(
      'seals a completed workflow at B-LT with a time-stamp, stores it and finalises it',
      async () => {
        gate().current = new HttpTimestampAuthority(tsa.url);
        alerts.length = 0;
        const w = await completed();
        const out = await sealAndFinalise(deps(), request(w.ref));
        expect(out.ok).toBe(true);
        if (!out.ok || !out.sealed) throw new Error(JSON.stringify(out));
        expect(out.attempts).toBe(1);
        expect(out.final.gate).toMatchObject({ status: 'finalised', alert: false });
        expect(await stateOf(w.ref)).toBe('finalised');
        expect(alerts).toEqual([]);

        // What is stored is the sealed PDF: the input, then the seal; the seal verifies.
        const stored = await sealed.read(w.ref.tenant, w.doc, w.workflowId);
        expect(stored).not.toBeNull();
        const pdf = stored!.bytes;
        expect(Buffer.from(pdf.subarray(0, input.length)).equals(Buffer.from(input))).toBe(true);
        expect(stored!.record.storedHash).toBe(sha256(pdf));
        const reports = verifyWithOpenssl(pdf, pki);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
        expect(reports[0]!.timestamp?.ok, reports[0]!.timestamp?.detail).toBe(true);
        expect(Buffer.from(pdf).toString('latin1')).toContain('/Type /DSS');

        // The route gives the same bytes back.
        const res = await fetch(`${h.base}/v1/documents/${w.doc}/workflow/final`, {
          headers: { authorization: `Bearer ${w.owner}` },
        });
        expect(res.status).toBe(200);
        expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(pdf));
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'seals at the level the workflow names (finalisation.seal)',
      async () => {
        gate().current = new HttpTimestampAuthority(tsa.url);
        const w = await completed({ seal: 'pades-b-lta' });
        const out = await sealAndFinalise(deps(), request(w.ref));
        if (!out.ok || !out.sealed) throw new Error(JSON.stringify(out));
        const pdf = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
        expect(findSignatures(pdf).map((s) => s.kind)).toEqual([
          'signature',
          'document-time-stamp',
        ]);
        for (const r of verifyWithOpenssl(pdf, pki)) expect(r.main.ok, r.main.detail).toBe(true);
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      "the seal time is the time-stamp token's and every other time is the server clock (FRW-053 criterion 6)",
      async () => {
        gate().current = new HttpTimestampAuthority(tsa.url);
        const w = await completed();
        const out = await sealAndFinalise(deps(), request(w.ref));
        if (!out.ok || !out.sealed) throw new Error(JSON.stringify(out));
        const pdf = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
        const token = cmsParts(findSignatures(pdf)[0]!.contents).token!;
        expect(token.length).toBeGreaterThan(100);
        // The outcome's seal time is the authority's clock: this machine's, within a minute.
        expect(Math.abs(out.timestampTime.getTime() - Date.now())).toBeLessThan(60_000);
        // The audit entry of the transition is stamped with the server clock given to the run.
        const entries = await h.parts.audit!.query(h.tenant, {
          doc: w.doc,
          kind: 'workflow.transition',
          limit: 20,
        });
        const entry = entries.find((e) => (e.data as { to?: string }).to === 'finalised');
        expect(entry).toBeDefined();
        expect(new Date(entry!.at).getTime()).toBe(SERVER_NOW);
        expect(out.timestampTime.getTime() - SERVER_NOW).toBeGreaterThan(30 * 60_000);
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'a time-stamp authority that never answers gives no seal: the workflow stays completed, the run is retried, audited and the operator is alerted (FRW-053 criterion 5, FRW-052 criterion 5)',
      async () => {
        gate().current = { stamp: () => Promise.reject(new Error('authority down')) };
        alerts.length = 0;
        sleeps.length = 0;
        const w = await completed();
        const sealedBefore = signingAudit.entries.filter((e) => e.event === 'seal.sealed').length;
        const out = await sealAndFinalise(deps(), request(w.ref));
        expect(out).toMatchObject({
          ok: true,
          sealed: false,
          attempts: 3,
          retryable: true,
          gate: { status: 'completed', alert: true, failure: { code: 'tsa_unreachable' } },
        });
        expect(sleeps).toEqual([10, 20]);
        expect(await stateOf(w.ref)).toBe('completed');
        expect(await sealed.read(w.ref.tenant, w.doc, w.workflowId)).toBeNull();
        expect(
          (await h.call('GET', `/v1/documents/${w.doc}/workflow/final`, { token: w.owner })).status,
        ).toBe(404);
        // One alert, naming the stop; one audit entry for the operator.
        expect(alerts).toEqual([
          {
            kind: 'workflow.finalisation_stopped',
            tenant: h.tenant,
            doc: w.doc,
            workflow: w.workflowId,
            stage: 'seal',
            reason: 'tsa_unreachable',
            code: 'tsa_unreachable',
            attempts: 3,
            retryable: true,
          },
        ]);
        const failed = await h.parts.audit!.query(h.tenant, {
          doc: w.doc,
          kind: 'workflow.finalisation_failed',
          limit: 10,
        });
        expect(failed).toHaveLength(1);
        expect(failed[0]!.data).toMatchObject({
          stage: 'seal',
          reason: 'tsa_unreachable',
          attempts: 3,
        });
        // The signing service made no seal in any of the three attempts.
        expect(signingAudit.entries.filter((e) => e.event === 'seal.sealed').length).toBe(
          sealedBefore,
        );
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'a later run seals the workflow once the authority answers again',
      async () => {
        gate().current = { stamp: () => Promise.reject(new Error('authority down')) };
        alerts.length = 0;
        const w = await completed();
        const r = request(w.ref);
        const first = await sealAndFinalise(deps(), r);
        expect(first).toMatchObject({ ok: true, sealed: false });
        expect(await stateOf(w.ref)).toBe('completed');
        gate().current = new HttpTimestampAuthority(tsa.url);
        const second = await sealAndFinalise(deps(), r);
        expect(second).toMatchObject({ ok: true, sealed: true, attempts: 1 });
        expect(await stateOf(w.ref)).toBe('finalised');
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'an authority that fails twice and then answers is waited for within one run, and no alert is raised',
      async () => {
        const flaky = new Flaky(2, new HttpTimestampAuthority(tsa.url));
        gate().current = flaky;
        alerts.length = 0;
        sleeps.length = 0;
        const w = await completed();
        const out = await sealAndFinalise(deps(), request(w.ref));
        expect(out).toMatchObject({ ok: true, sealed: true, attempts: 3 });
        expect(sleeps).toEqual([10, 20]);
        expect(alerts).toEqual([]);
        expect(await stateOf(w.ref)).toBe('finalised');
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      "a request the service refuses is not retried: the export worker's credential does not seal",
      async () => {
        gate().current = new HttpTimestampAuthority(tsa.url);
        alerts.length = 0;
        sleeps.length = 0;
        const w = await completed();
        const out = await sealAndFinalise(deps(WORKER_SECRET), request(w.ref));
        expect(out).toMatchObject({
          ok: true,
          sealed: false,
          attempts: 1,
          retryable: false,
          gate: { status: 'completed', alert: true, failure: { code: 'seal_failed' } },
        });
        expect(sleeps).toEqual([]);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ code: 'wrong_caller', retryable: false });
        expect(await stateOf(w.ref)).toBe('completed');
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'a service that is not there is retried like a time-stamp authority that is not there',
      async () => {
        alerts.length = 0;
        sleeps.length = 0;
        const w = await completed();
        const dead: SealAndFinaliseDeps = {
          ...deps(),
          signing: new HttpSigningClient({
            url: 'http://127.0.0.1:9',
            credential: DOCUMENT_SERVICE_SECRET,
            timeoutMs: 5_000,
          }),
        };
        const out = await sealAndFinalise(dead, request(w.ref));
        expect(out).toMatchObject({
          ok: true,
          sealed: false,
          attempts: 3,
          gate: { failure: { code: 'signing_unavailable' } },
        });
        expect(alerts[0]).toMatchObject({ reason: 'signing_unavailable', code: 'unreachable' });
        expect(await stateOf(w.ref)).toBe('completed');
      },
      300_000,
    );

    it.skipIf(skip !== null)(
      'does not send a PDF for a workflow that is not completed',
      async () => {
        const before = signingAudit.entries.length;
        const w = await completed();
        gate().current = new HttpTimestampAuthority(tsa.url);
        expect((await sealAndFinalise(deps(), request(w.ref))).ok).toBe(true);
        const mid = signingAudit.entries.length;
        expect(mid).toBeGreaterThan(before);
        // Finalised now: a second run is refused before anything is sent.
        const again = await sealAndFinalise(deps(), request(w.ref));
        expect(again).toEqual({
          ok: false,
          problem: { code: 'invalid_state', state: 'finalised' },
        });
        expect(signingAudit.entries.length).toBe(mid);
      },
      300_000,
    );
  });
}
