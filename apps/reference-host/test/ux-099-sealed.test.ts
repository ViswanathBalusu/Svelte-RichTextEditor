// UX-099 criterion 5: the host retrieves the sealed PDF and the evidence bundle and makes them
// available to the owner, end to end against the real document service and the real signing service.
//
// Nothing here stands in for the service: the host sends the workflow; each participant gets the
// host's invitation, asks for a passcode, receives the host's token and completes through the
// service's own route; the service starts the final export, seals the PDF with the signing service
// (a test certificate chain, a key in this process, a local OpenSSL time-stamp authority; owner
// decisions 221 to 223) and raises `dep.workflow.finalised.v1`; the host's handler fetches both
// files. The compile worker is the one stand-in: its handler stores a fixed one-page PDF and reports
// the pair of compile hashes (as `frw-053.live-seal.test.ts` of the service does).
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryEventSink } from '../../../services/document-service/src/control-plane/events.ts';
import { objectKeys } from '../../../services/document-service/src/objects/store.ts';
import { HttpSigningClient } from '../../../services/document-service/src/workflow/signing-client.ts';
import { DepClient } from '../../../services/document-service/test/data-plane/client.ts';
import {
  HttpTimestampAuthority,
  type TimestampSource,
} from '../../../services/signing-service/src/cms.ts';
import { createSigningServer } from '../../../services/signing-service/src/http.ts';
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
import { serviceTemplateContent } from '../src/lib/server/documents.ts';
import {
  WorkflowStore,
  handleWorkflowEvent,
  resultFile,
  sendForCompletion,
  startPasscode,
  verifyPasscode,
  type EventDeps,
} from '../src/lib/server/send-for-completion.ts';
import { startHarness, type Harness } from './support.ts';

const SIGN_FIELD = 'fLeaseSign000001';
const PUBLIC_URL = 'http://127.0.0.1:56491';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const PEOPLE = [
  {
    role: 'tenant',
    name: 'Tess Tenant',
    email: 'tess@people.example.test',
    kind: 'filler' as const,
  },
  {
    role: 'landlord',
    name: 'Larry Landlord',
    email: 'larry@people.example.test',
    kind: 'signer' as const,
  },
];

async function until(what: string, ok: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const skip = opensslAvailable() ? null : 'no openssl';

describe('UX-099 criterion 5: the sealed PDF and the evidence bundle, from a real seal', () => {
  let h: Harness;
  let pki: TestPki;
  let tsa: TestTsa;
  let signing: Server;
  let dir: string;
  let deps: EventDeps;
  let doc = '';
  const sink = new MemoryEventSink();
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const clients: DepClient[] = [];
  const input = classicPdf();
  let seen = 0;

  beforeAll(async () => {
    if (skip) return;
    const ks = new InProcessKeyService();
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    const authority: TimestampSource = new HttpTimestampAuthority(tsa.url);
    const world = makeWorld({
      operator: { id: 'operator-key', keyService: ks, pki },
      tsaUrl: tsa.url,
      timestamps: { stamp: (d) => authority.stamp(d) },
    });
    signing = createSigningServer(world.service, { maxBodyBytes: 5_000_000 });
    await new Promise<void>((r) => signing.listen(0, '127.0.0.1', r));
    const addr = signing.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const client = new HttpSigningClient({
      url: `http://127.0.0.1:${addr.port}`,
      credential: DOCUMENT_SERVICE_SECRET,
      timeoutMs: 120_000,
    });
    let objects: Harness['service']['parts']['objects'] | null = null;
    h = await startHarness({
      service: {
        events: sink,
        finalSealing: {
          signing: {
            seal: (job) => client.seal(job),
            anchor: (job) => client.anchor(job),
            extend: (job) => client.extend(job),
          },
          retry: { attempts: 2, delaysMs: [10] },
          retainMs: 365 * 24 * 3600 * 1000,
          sleep: () => Promise.resolve(),
        },
        jobHandlers: {
          export: async (job, ctx) => {
            await ctx.report('compiling', 50);
            await objects!.put(objectKeys.exportFile(job.tenant, job.id, 'output.pdf'), input);
            await objects!.put(
              objectKeys.exportFile(job.tenant, job.id, 'layout.json'),
              new TextEncoder().encode(
                JSON.stringify({
                  seq: job.payload['seq'],
                  classVersion: '1.0.0',
                  granularity: 'block',
                  unit: 'twip',
                  pages: [{ n: 1, setup: null, starts: null, opensWith: 'text' }],
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
      },
      serviceConfig: { jobIdleMs: 20, jobRetryAfterMs: 10 },
    });
    objects = h.service.parts.objects;
    dir = await mkdtemp(join(tmpdir(), 'docedit-ux099-seal-'));
    deps = {
      host: { ...h.host, config: { dataDir: dir } },
      store: await WorkflowStore.open(dir),
      mail: (m) => {
        mails.push(m);
        return Promise.resolve();
      },
      publicUrl: PUBLIC_URL,
    };
    const st = h.host.seed.serviceTemplates![0]!;
    const created = await h.host.service.createDocument(
      { content: await serviceTemplateContent(h.host.seedDir, st), title: 'Lease (sealed)' },
      'ux099-sealed',
      'u-olivia',
    );
    doc = created.id;
    await h.host.catalogue.put({
      id: doc,
      externalId: 'ux099-sealed',
      title: 'Lease (sealed)',
      template: 'lease',
      createdBy: 'u-olivia',
      createdAt: new Date().toISOString(),
      roles: { 'u-olivia': 'owner', 'u-ada': 'editor' },
      accessSince: {},
      deletedAt: null,
    });
  }, 300_000);

  afterAll(async () => {
    for (const c of clients.splice(0)) c.terminate();
    await h?.close();
    await new Promise<void>((r) => (signing ? signing.close(() => r()) : r()));
    await tsa?.stop();
    pki?.remove();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Hands each event the service has raised since the last call to the host's handler. */
  async function pump(): Promise<void> {
    while (seen < sink.events.length) {
      const e = sink.events[seen]!;
      seen += 1;
      await handleWorkflowEvent(deps, {
        webhookId: `msg_${seen}`,
        type: e.type,
        subject: e.subject,
        test: false,
        body: { data: e.data },
      });
    }
  }

  /** The participant follows the host's mail, takes the passcode and completes through the service. */
  async function completeAs(index: number): Promise<void> {
    const person = PEOPLE[index]!;
    const invitation = [...mails].reverse().find((m) => m.to === person.email)!;
    const reference = /\/fill\/([\w-]+)/.exec(invitation.text)![1]!;
    expect(await startPasscode(deps, reference)).toEqual({ name: person.name });
    const code = /passcode is (\d{6})/.exec(mails.at(-1)!.text)![1]!;
    const got = await verifyPasscode(deps, reference, code);
    if (!got.ok) throw new Error(`passcode refused: ${got.reason}`);
    // The first connection of a participant moves the workflow to `in_progress`.
    const c = await DepClient.connect(`${h.service.url.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    expect((await c.hello(got.token)).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    const pid = `p${index + 1}`;
    const done = await fetch(`${h.rest}/documents/${doc}/workflow/participants/${pid}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${got.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(done.status, await done.text()).toBe(200);
    await pump();
  }

  const stateOf = async () =>
    (await h.service.parts.workflows!.read(h.tenant, doc))?.state ?? 'none';

  it.skipIf(skip !== null)(
    'fetches the sealed PDF and the evidence bundle after the service finalises, for the owner only',
    async () => {
      await sendForCompletion(deps.host, deps.store, {
        doc,
        owner: 'u-olivia',
        participants: PEOPLE,
      });
      await pump();
      await completeAs(0);
      await until('the second participant to be invited', () => {
        void pump();
        return mails.some((m) => m.to === PEOPLE[1]!.email && /complete:/.test(m.subject));
      });
      await completeAs(1);
      await until('finalised', async () => (await stateOf()) === 'finalised');
      await until('the host to fetch the results', async () => {
        await pump();
        return deps.store.get(doc)?.results !== undefined;
      });

      expect(deps.store.get(doc)?.state).toBe('finalised');
      const pdf = await resultFile(deps.host, deps.store, doc, 'u-olivia', 'sealed-pdf');
      expect(pdf?.type).toBe('application/pdf');
      const bytes = pdf!.bytes;
      // The sealed bytes are the compile's PDF followed by the seal, and the seal and its
      // time-stamp verify against the test chain.
      expect(Buffer.from(bytes.subarray(0, input.length)).equals(Buffer.from(input))).toBe(true);
      expect(bytes.length).toBeGreaterThan(input.length);
      const reports = verifyWithOpenssl(bytes, pki);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
      expect(reports[0]!.timestamp?.ok, reports[0]!.timestamp?.detail).toBe(true);

      // The host holds what the service returns from its own route, byte for byte.
      const direct = await h.host.service.getSealedPdf(doc);
      expect(sha256(bytes)).toBe(sha256(direct));

      const evidence = await resultFile(deps.host, deps.store, doc, 'u-olivia', 'evidence');
      expect(evidence?.type).toBe('application/json');
      const bundle = JSON.parse(Buffer.from(evidence!.bytes).toString('utf8')) as unknown;
      expect(bundle).toBeTypeOf('object');
      expect(sha256(evidence!.bytes)).toBe(sha256(await h.host.service.getEvidenceBundle(doc)));

      // Nobody but the owner is given either file.
      for (const person of ['u-ada', 'u-bob'])
        for (const kind of ['sealed-pdf', 'evidence'] as const)
          expect(await resultFile(deps.host, deps.store, doc, person, kind)).toBeNull();
    },
    240_000,
  );
});
