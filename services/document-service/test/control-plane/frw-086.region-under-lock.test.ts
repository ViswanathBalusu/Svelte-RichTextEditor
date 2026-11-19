// FRW-086 criterion 2 through the real service (lane w4, 2026-11-18): how an edit by a participant who
// holds a role-granted region is attributed, checked and kept stable while the document is locked
// (07 §4 limit 1; owner decision 132 of 2026-11-15; docs/adr/0381-w4-FRW-086-long-answers-under-a-lock.md).
// The real data plane, a real WebSocket client, the asset worker for the signature image, memory
// storage and, when the test environment is up, PostgreSQL in Podman.
import { uuid7 } from '@docedit/model';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { DepClient, insertText, type Received } from '../data-plane/client.ts';
import { posInside, posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const LEGAL_PARAGRAPH = 'pLegal0000000001';
const INTRO = 'pIntro0000000001';
const SIG_FIELD = 'fs00000000000001';
const TEXT_ID = 'esign-consent';
const VERSION = 1;

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pSign00000000001' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: SIG_FIELD,
          key: 'tenant.sig',
          kind: 'signature',
          label: 'tenant.sig',
          assignee: 'tenant',
          required: false,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string, kinds: [string, string]) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cd1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  consent: { textId: TEXT_ID, version: VERSION },
  participants: [
    { id: 'p1', roles: ['tenant'], kind: kinds[0], order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: kinds[1], order: 2, sub: 'sub-p2' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`an edit in a region granted to a role under the lock (${storage}; FRW-086)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        realDataPlane: true,
        views: FULL_VIEWS,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: { jobIdleMs: 20 },
        parts: { consentTexts: texts },
      });
      texts.put(
        h.tenant,
        TEXT_ID,
        VERSION,
        'I agree to sign this document electronically. Test text only.',
      );
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const tree = () => schema.nodeFromJSON((document() as { doc: unknown }).doc);
    const typing = (text: string) => insertText(posOf(tree(), LEGAL_PARAGRAPH) + 1, text);
    const post = async (path: string, token: string, body?: unknown) => {
      const r = await h.call('POST', path, { token, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${path} ${r.text}`).toBe(200);
      return r;
    };
    const tokenFor = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });

    /** A sent workflow on a document whose region is granted to `role:<role>`. */
    async function sent(role: string, kinds: [string, string]) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-086-${uuid7()}` });
      const read = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const put = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: owner,
        body: { grants: [{ region: LEGAL, principal: `role:${role}`, role: 'editor' }] },
        headers: { 'If-Match': read.headers.get('etag')! },
      });
      expect(put.status, put.text).toBe(200);
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, kinds),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      await post(`/v1/documents/${doc}/workflow/send`, owner);
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    async function connect(token: string, doc: string): Promise<DepClient> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token)).t).toBe('welcome');
      const o: Received = await c.open(1, doc);
      expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
      return c;
    }
    const headSeq = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.head(ref)).seq;
    const submit = async (c: DepClient, ref: { tenant: string; doc: string }, step: unknown) =>
      c.submit(1, { base: await headSeq(ref), steps: [step] });
    const participant = async (doc: string, id: string) =>
      (await h.parts.workflows!.read(h.tenant, doc))!.participants.find((p) => p.id === id)!;

    it.skipIf(skip)(
      'attributes the edit to the participant, refuses what is outside the region, and keeps the participant completed through a resume that changed only the region',
      async () => {
        const { doc, owner, ref } = await sent('tenant', ['filler', 'filler']);
        const tenant = await connect(tokenFor(doc, 'p1'), doc);
        await expect
          .poll(async () => (await participant(doc, 'p1')).firstViewedAt, { timeout: 5000 })
          .toBeDefined();

        // Attribution: an ordinary commit by the participant's `sub`. Its origin is the client's own
        // hint, as for any edit (08 §2), not a reserved server origin such as `sign` or `rules`.
        const before = await headSeq(ref);
        const ack = await submit(tenant, ref, typing('Rent: '));
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
        const commits = (await h.parts.logs.read(ref)).filter(
          (c) => c.seq > before && c.kind === 'steps',
        );
        expect(commits).toHaveLength(1);
        const edit = commits[0]!;
        expect(edit.user).toBe((await h.parts.users.resolve(h.tenant, 'sub-p1')).surrogate);
        expect(edit.origin).toBe('input');
        expect(edit.kind).toBe('steps');

        // The outcome check: the same participant is refused every change outside the region, and
        // one that reaches out of it, and nothing is stored.
        const t = tree();
        const regionAt = posOf(t, LEGAL);
        const steps: Record<string, unknown> = {
          'a text outside the region': insertText(posInside(t, INTRO) + 1, 'x'),
          'the region itself': {
            stepType: 'replace',
            from: regionAt,
            to: regionAt + t.nodeAt(regionAt)!.nodeSize,
          },
          'a range from outside into the region': {
            stepType: 'replace',
            from: posInside(t, INTRO) + 1,
            to: posOf(t, LEGAL_PARAGRAPH) + 2,
          },
        };
        const head = await headSeq(ref);
        for (const [what, step] of Object.entries(steps)) {
          const r = await submit(tenant, ref, step);
          expect(r.t, `${what}: ${JSON.stringify(r)}`).toBe('sync.reject');
        }
        expect(await headSeq(ref)).toBe(head);

        // The participant completes. A correction changes only the region (the tenant's own edit) and
        // the owner resumes: the participant stays completed, because the region is not part of the
        // frozen body.
        await post(
          `/v1/documents/${doc}/workflow/participants/p1/complete`,
          tokenFor(doc, 'p1'),
          {},
        );
        expect((await participant(doc, 'p1')).state).toBe('completed');
        await post(`/v1/documents/${doc}/workflow/correct`, owner);
        await post(`/v1/documents/${doc}/workflow/resume`, owner);
        expect((await participant(doc, 'p1')).state).toBe('completed');

        // A change outside the region during a correction does reset the participant.
        await post(`/v1/documents/${doc}/workflow/correct`, owner);
        const ownerWs = await connect(owner, doc);
        const fixed = await submit(ownerWs, ref, insertText(posInside(t, INTRO) + 1, 'Dear '));
        expect(fixed.t, JSON.stringify(fixed)).toBe('sync.ack');
        await post(`/v1/documents/${doc}/workflow/resume`, owner);
        expect((await participant(doc, 'p1')).state).not.toBe('completed');
      },
      60_000,
    );

    it.skipIf(skip)(
      'leaves a signature as signed when another role writes in its region afterwards',
      async () => {
        const { doc, ref } = await sent('landlord', ['signer', 'filler']);
        const p1 = tokenFor(doc, 'p1');
        // The tenant (first by order) opens the document, which starts the workflow, then consents,
        // uploads the image, signs and completes.
        await connect(p1, doc);
        await expect
          .poll(async () => (await participant(doc, 'p1')).firstViewedAt, { timeout: 5000 })
          .toBeDefined();
        expect(
          (
            await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/consent`, {
              token: p1,
              body: {},
            })
          ).status,
        ).toBe(200);
        const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
          token: p1,
          body: { filename: 'sig.png', mime: 'image/png', size: PNG.length },
        });
        expect(r.status, r.text).toBe(201);
        const asset = r.json.asset as string;
        await h.service.assets.putQuarantined(h.tenant, asset, PNG);
        expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: p1 })).status).toBe(
          202,
        );
        for (let i = 0; i < 300; i++) {
          if ((await h.parts.assetRegistry.get(h.tenant, asset))?.state === 'ready') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const signed = await h.call('POST', `/v1/documents/${doc}/fields/${SIG_FIELD}/sign`, {
          token: p1,
          body: { asset, mode: 'uploaded' },
        });
        expect(signed.status, signed.text).toBe(200);
        const signSeq = (signed.json as { seq: number }).seq;
        const signedCommit = (await h.parts.logs.read(ref, signSeq, signSeq))[0]!;
        const factOf = async () =>
          (
            (await h.parts.evidence!.list(h.tenant, doc)).find((e) => e.item === 'signed')!.evidence
              .items as { signings: Array<Record<string, unknown>> }
          ).signings[0]!;
        const factBefore = await factOf();
        expect(factBefore['seq']).toBe(signSeq);
        await post(`/v1/documents/${doc}/workflow/participants/p1/complete`, p1, {});

        // The landlord is now active and writes in the region granted to the role.
        const landlord = await connect(tokenFor(doc, 'p2'), doc);
        const head = await headSeq(ref);
        const ack = await submit(landlord, ref, typing('Landlord answer. '));
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
        const later = (await h.parts.logs.read(ref)).filter((c) => c.seq > head);
        const edit = later.find((c) => c.kind === 'steps')!;
        expect(edit.seq).toBeGreaterThan(signSeq);
        expect(edit.user).toBe((await h.parts.users.resolve(h.tenant, 'sub-p2')).surrogate);

        // The signature is as it was: the same commit in the log, the same value, and the evidence
        // still names the signing commit and its chain hash.
        expect((await h.parts.logs.read(ref, signSeq, signSeq))[0]).toEqual(signedCommit);
        const values = (
          await h.call('GET', `/v1/documents/${doc}/field-values`, { token: h.serviceJwt() })
        ).json.values as Record<string, unknown>;
        expect(values['tenant.sig']).toEqual({ asset, mode: 'uploaded' });
        expect(await factOf()).toEqual(factBefore);
      },
      60_000,
    );
  });
}
