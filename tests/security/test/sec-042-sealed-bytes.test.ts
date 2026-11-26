// SEC-042 criteria 4 and 5 (lane w8, 2026-11-26): what the signing service is asked to seal is
// exactly the stored PDF, and long-term validation only appends.
//
// The live path of finalisation is run with nothing called by hand (as
// services/document-service/test/control-plane/frw-053.live-seal.test.ts does): the last
// participant completes, the final export job stores a PDF and reports the hashes of the pair of
// compiles, the seal step reads the PDF from the object store and sends it to the real signing
// service over HTTP (a test chain, a key in this process, a local OpenSSL time-stamp authority).
// The document service's client is given a `fetch` that records every request body and, for one
// test, rewrites an answer. Memory storage. The key is in the test process, so the test shows the
// rules and not the key's place.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTimestampAuthority } from '../../../services/signing-service/src/cms.ts';
import { createSigningServer } from '../../../services/signing-service/src/http.ts';
import { verifySealedPdf } from '../../../services/signing-service/src/verify-sealed.ts';
import { classicPdf } from '../../../services/signing-service/test/support/classic-pdf.ts';
import {
  makePki,
  opensslAvailable,
  type TestPki,
} from '../../../services/signing-service/test/support/pki.ts';
import {
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
} from '../../../services/signing-service/test/support/service-world.ts';
import { startTestTsa, type TestTsa } from '../../../services/signing-service/test/support/tsa.ts';
import { verifyWithOpenssl } from '../../../services/signing-service/test/support/verify.ts';
import { InProcessKeyService } from '../../../services/signing-service/test/support/world.ts';
import { DepClient } from '../../../services/document-service/test/data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../../../services/document-service/test/control-plane/support.ts';
import { objectKeys } from '../../../services/document-service/src/objects/store.ts';
import { HttpSigningClient } from '../../../services/document-service/src/workflow/signing-client.ts';
import {
  extendFinalised,
  type ExtendDeps,
} from '../../../services/document-service/src/workflow/extend-sealed.ts';
import { MemorySealedPdfStore } from '../../../services/document-service/src/workflow/sealed-store.ts';
import { MemoryAnchorStore } from '../../../services/document-service/src/workflow/anchor-store.ts';

const FIELD = 'ff00000000000421';

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
    attrs: { id: 'pSec042000000042' },
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
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c42',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const RETAIN_MS = 365 * 24 * 3600 * 1000;

interface SealRequest {
  readonly pdfSha256: string;
  readonly compileSha256: [string, string];
  readonly pdf: string;
  readonly seq: number;
  readonly documentId: string;
}

describe('the hash sent to the signing service is the stored PDF, and validation data only appends (SEC-042)', async () => {
  const skip = (await skipReason('memory')) ?? (opensslAvailable() ? null : 'no openssl');
  let h: Harness;
  let pki: TestPki;
  let tsa: TestTsa;
  let server: Server;
  let url = '';
  const sealed = new MemorySealedPdfStore();
  const anchors = new MemoryAnchorStore();
  const clients: DepClient[] = [];
  const input = classicPdf();
  /** Every seal request the document service sent, in order. */
  const sent: SealRequest[] = [];
  /** What the compile worker's stand-in does: honest, or stores other bytes than it reports. */
  const compile = { mode: 'honest' as 'honest' | 'stored_other' };
  /** For one test: the answer of /v1/extend is rewritten, not appended. */
  const rewrite = { extend: false };

  const recordingFetch: typeof fetch = async (target, init) => {
    const where = String(target);
    if (where.endsWith('/v1/seal') && typeof init?.body === 'string')
      sent.push(JSON.parse(init.body) as SealRequest);
    const res = await fetch(target, init);
    if (!(rewrite.extend && where.endsWith('/v1/extend') && res.ok)) return res;
    const wire = (await res.json()) as { pdf: string; sealedSha256: string };
    const bytes = new Uint8Array(Buffer.from(wire.pdf, 'base64'));
    bytes[20] = (bytes[20] as number) ^ 1;
    return new Response(
      JSON.stringify({
        ...wire,
        pdf: Buffer.from(bytes).toString('base64'),
        sealedSha256: sha256(bytes),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = () =>
    new HttpSigningClient({
      url,
      credential: DOCUMENT_SERVICE_SECRET,
      timeoutMs: 120_000,
      fetch: recordingFetch,
    });

  beforeAll(async () => {
    if (skip) return;
    const ks = new InProcessKeyService();
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    const world = makeWorld({
      operator: { id: 'operator-key', keyService: ks, pki },
      tsaUrl: tsa.url,
      timestamps: new HttpTimestampAuthority(tsa.url),
    });
    server = createSigningServer(world.service, { maxBodyBytes: 5_000_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    url = `http://127.0.0.1:${addr.port}`;
    h = await startHarness('memory', {
      realDataPlane: true,
      parts: { sealedPdfs: sealed, anchors },
      logger: { info() {}, warn() {}, error() {} },
      finalSealing: {
        signing: {
          seal: (job) => client().seal(job),
          anchor: (job) => client().anchor(job),
          extend: (job) => client().extend(job),
        },
        retry: { attempts: 1, delaysMs: [10] },
        retainMs: RETAIN_MS,
        sleep: () => Promise.resolve(),
      },
      jobHandlers: {
        export: async (job, ctx) => {
          await ctx.report('compiling', 50);
          // `stored_other`: the object store holds other bytes than the pair agreed on.
          const stored = new Uint8Array(input);
          if (compile.mode === 'stored_other')
            stored[stored.length - 1] = (stored[stored.length - 1] as number) ^ 1;
          await h.parts.objects.put(
            objectKeys.exportFile(job.tenant, job.id, 'output.pdf'),
            stored,
          );
          const hash = sha256(input);
          return {
            output: 'output.pdf',
            pages: 1,
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
    const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-042-${doc}` });
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
    return { doc, ref: { tenant: h.tenant, doc }, workflowId: done.json.id as string };
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
    'criterion 4: the hash in the seal request is the SHA-256 of the PDF in the object store, and the stored sealed PDF begins with those bytes',
    async () => {
      compile.mode = 'honest';
      sent.length = 0;
      const w = await complete();
      await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');

      const mine = sent.filter((s) => s.documentId === w.doc);
      expect(mine).toHaveLength(1);
      const request = mine[0]!;
      // The export job's own output, read back from the object store by its key.
      const jobId = (await jobIdOf(w.ref))!;
      const output = await h.parts.objects.get(
        objectKeys.exportFile(h.tenant, jobId, 'output.pdf'),
      );
      expect(request.pdfSha256).toBe(sha256(output));
      // The pair of compiles, the hash sent and the bytes sent are one hash.
      expect(request.compileSha256).toEqual([request.pdfSha256, request.pdfSha256]);
      expect(sha256(new Uint8Array(Buffer.from(request.pdf, 'base64')))).toBe(request.pdfSha256);
      // The sealed PDF in the store is those bytes, then the seal, which validates.
      const stored = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
      expect(sha256(stored.subarray(0, output.length))).toBe(request.pdfSha256);
      const reports = verifyWithOpenssl(stored, pki);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
    },
    300_000,
  );

  it.skipIf(skip !== null)(
    'criterion 4: when the stored PDF is not the one the pair agreed on, nothing is sent to the signing service and the workflow stays completed',
    async () => {
      compile.mode = 'stored_other';
      sent.length = 0;
      const w = await complete();
      await waitFor('the export to finish', async () => (await jobIdOf(w.ref)) !== null);
      // The seal step has run (the export hook starts it); ask once more to see its answer.
      await new Promise((r) => setTimeout(r, 300));
      const again = await h.service.sealer!.sealCompletedWorkflow(w.ref);
      expect(again).toMatchObject({ status: expect.stringMatching(/stopped|gave_up/) });
      expect(sent.filter((s) => s.documentId === w.doc)).toHaveLength(0);
      expect(await stateOf(w.ref)).toBe('completed');
      expect(await sealed.read(w.ref.tenant, w.doc, w.workflowId)).toBeNull();
      compile.mode = 'honest';
    },
    300_000,
  );

  it.skipIf(skip !== null)(
    'criterion 4: the signing service itself refuses a request whose hash is not the hash of its bytes, and a hash that is not the pair',
    async () => {
      const post = async (patch: Record<string, unknown>) => {
        const pdf = input;
        const res = await fetch(`${url}/v1/seal`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${DOCUMENT_SERVICE_SECRET}`,
          },
          body: JSON.stringify({
            tenant: 'tenant-a',
            documentId: 'doc-sec-042',
            seq: 3,
            pdfSha256: sha256(pdf),
            compileSha256: [sha256(pdf), sha256(pdf)],
            pdf: Buffer.from(pdf).toString('base64'),
            ...patch,
          }),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      // The named hash is another PDF's hash.
      const other = new Uint8Array(input);
      other[other.length - 1] = (other[other.length - 1] as number) ^ 1;
      const wrongHash = await post({ pdfSha256: sha256(other) });
      expect(wrongHash.json['ok']).not.toBe(true);
      expect(wrongHash.status).toBeGreaterThanOrEqual(400);
      // The bytes are not the pair's: the compile hashes are not both the PDF's hash.
      const wrongPair = await post({ compileSha256: [sha256(input), sha256(other)] });
      expect(wrongPair.json['ok']).not.toBe(true);
      expect(wrongPair.status).toBeGreaterThanOrEqual(400);
      // Control: the same request with the matching hashes seals.
      const good = await post({});
      expect(good.status).toBe(200);
      expect(good.json['ok']).toBe(true);
    },
    300_000,
  );

  it.skipIf(skip !== null)(
    'criterion 5: long-term validation data and a renewed time-stamp are appended; the sealed object stays byte for byte and the update begins with it',
    async () => {
      compile.mode = 'honest';
      rewrite.extend = false;
      const w = await complete();
      await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');
      const original = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
      const seq = sent.find((s) => s.documentId === w.doc)!.seq;
      const deps: ExtendDeps = {
        workflows: h.parts.workflows!,
        sealed,
        signing: client(),
        now: () => Date.now(),
        retainMs: RETAIN_MS,
      };
      const ask = { tenant: w.ref.tenant, doc: w.doc, seq, idempotencyKey: `ltv-${w.doc}` };
      const first = await extendFinalised(deps, { ...ask, validation: true });
      if (!first.ok) throw new Error(JSON.stringify(first));
      const update = (await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!;
      expect(update.n).toBe(1);
      expect(update.bytes.length).toBeGreaterThan(original.length);
      // The sealed bytes are the first bytes of the update, and of the object kept.
      expect(same(update.bytes.subarray(0, original.length), original)).toBe(true);
      expect(same((await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes, original)).toBe(
        true,
      );
      // The original signature still validates, over its own byte range, in the updated file.
      const proof = verifyWithOpenssl(update.bytes, pki);
      expect(proof.map((r) => r.signature.kind)).toEqual(['signature', 'document-time-stamp']);
      for (const r of proof) expect(r.main.ok, r.main.detail).toBe(true);
      expect((await verifySealedPdf(update.bytes, [pki.root])).ok).toBe(true);
    },
    300_000,
  );

  it.skipIf(skip !== null)(
    'criterion 5: an answer that rewrites the sealed bytes instead of appending is refused and nothing is stored',
    async () => {
      compile.mode = 'honest';
      rewrite.extend = false;
      const w = await complete();
      await waitFor('finalised', async () => (await stateOf(w.ref)) === 'finalised');
      const original = (await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes;
      const seq = sent.find((s) => s.documentId === w.doc)!.seq;
      const deps: ExtendDeps = {
        workflows: h.parts.workflows!,
        sealed,
        signing: client(),
        now: () => Date.now(),
        retainMs: RETAIN_MS,
      };
      rewrite.extend = true;
      try {
        const out = await extendFinalised(deps, {
          tenant: w.ref.tenant,
          doc: w.doc,
          seq,
          idempotencyKey: `rewrite-${w.doc}`,
          validation: true,
        });
        expect(out).toMatchObject({ ok: false, code: 'not_an_append' });
      } finally {
        rewrite.extend = false;
      }
      // No update was stored, and the sealed object is unchanged.
      expect((await sealed.readLatest(w.ref.tenant, w.doc, w.workflowId))!.n).toBe(0);
      expect(same((await sealed.read(w.ref.tenant, w.doc, w.workflowId))!.bytes, original)).toBe(
        true,
      );
    },
    300_000,
  );

  /** The identifier of the final export job of the workflow of a document, once it exists. */
  async function jobIdOf(ref: { tenant: string; doc: string }): Promise<string | null> {
    const { finalExportJobId } =
      await import('../../../services/document-service/src/workflow/final-export-start.ts');
    const wf = await h.parts.workflows!.read(ref.tenant, ref.doc);
    if (wf === null) return null;
    const id = finalExportJobId(ref, wf);
    if (id === null) return null;
    const job = await h.parts.queue!.get(ref.tenant, id);
    return job !== null && job.state === 'completed' ? id : null;
  }
});
