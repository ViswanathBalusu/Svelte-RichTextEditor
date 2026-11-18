// FRW-046 through the real service (lane w4, 2026-11-18): a participant signs a signature and an
// initials field with `POST /documents/{id}/fields/{fid}/sign`. The real data plane applies the
// server-authored commit with origin `sign` (the outbox delivers it to the room), the asset worker
// handles the uploaded image, and the evidence and the events are read back. Memory storage and,
// when the test environment is up, PostgreSQL in Podman. The component that calls the route
// (criterion 1) is the editor's and is not tested here.
// docs/adr/0397-w4-FRW-046-sign-commit.md (proposed).
import { createHash } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TEXT_ID = 'esign-consent';
const VERSION = 3;
const TEXT = 'I agree to sign this document electronically. Test text only.';
const DAY = 86_400_000;

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const id = (n: number) => `fs${String(n).padStart(14, '0')}`;
const F = {
  sig: id(1),
  initials: id(2),
  dateTenant: id(3),
  dateLandlord: id(4),
  sigLandlord: id(5),
  hidden: id(6),
  text: id(7),
};

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  defs.push({
    type: 'rule_def',
    attrs: { id: 'ruleHide00000001', when: true, then: [{ hide: ['tenant.hidden'] }] },
  });
  const ff = (n: number, key: string, kind: string, assignee: string) => ({
    type: 'form_field',
    attrs: { id: id(n), key, kind, label: key, assignee, required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pSign00000000001' },
    content: [
      ff(1, 'tenant.sig', 'signature', 'tenant'),
      { type: 'text', text: ' ' },
      ff(2, 'tenant.initials', 'initials', 'tenant'),
      { type: 'text', text: ' ' },
      ff(3, 'tenant.date', 'dateSigned', 'tenant'),
      { type: 'text', text: ' ' },
      ff(4, 'landlord.date', 'dateSigned', 'landlord'),
      { type: 'text', text: ' ' },
      ff(5, 'landlord.sig', 'signature', 'landlord'),
      { type: 'text', text: ' ' },
      ff(6, 'tenant.hidden', 'signature', 'tenant'),
      { type: 'text', text: ' ' },
      ff(7, 'tenant.name', 'text', 'tenant'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string, timeZone = 'UTC') => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cc1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone,
  consent: { textId: TEXT_ID, version: VERSION },
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`signing a signature field (${storage}; FRW-046)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        realDataPlane: true,
        views: FULL_VIEWS,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: { jobIdleMs: 20 },
        parts: { consentTexts: texts },
      });
      texts.put(h.tenant, TEXT_ID, VERSION, TEXT);
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const token = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });

    async function workflow(timeZone = 'UTC') {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-046-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc, timeZone),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(sent.status, sent.text).toBe(200);
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    async function readyAsset(doc: string, tok: string): Promise<string> {
      const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token: tok,
        body: { filename: 'sig.png', mime: 'image/png', size: PNG.length },
      });
      expect(r.status, r.text).toBe(201);
      const asset = r.json.asset as string;
      await h.service.assets.putQuarantined(h.tenant, asset, PNG);
      expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: tok })).status).toBe(
        202,
      );
      let row = await h.parts.assetRegistry.get(h.tenant, asset);
      for (let i = 0; i < 300 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        row = await h.parts.assetRegistry.get(h.tenant, asset);
      }
      expect(row?.state).toBe('ready');
      return asset;
    }

    const accept = (doc: string, pid: string) =>
      h.call('POST', `/v1/documents/${doc}/workflow/participants/${pid}/consent`, {
        token: token(doc, pid),
        body: {},
      });
    const sign = (
      doc: string,
      pid: string,
      fid: string,
      payload: unknown,
      headers?: Record<string, string>,
    ) =>
      h.call('POST', `/v1/documents/${doc}/fields/${fid}/sign`, {
        token: token(doc, pid),
        body: payload,
        ...(headers ? { headers } : {}),
      });
    const signCommits = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.origin === 'sign');
    const values = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}/field-values`, { token: h.serviceJwt() })).json
        .values as Record<string, unknown>;

    it.skipIf(skip)(
      'refuses what P7 and the consent forbid, and writes nothing (criteria 2 and 6; FRW-044 criterion 3)',
      async () => {
        const { doc, ref } = await workflow();
        const mine = await readyAsset(doc, token(doc, 'p1'));
        const ownersAsset = await readyAsset(
          doc,
          h.userToken({ [doc]: 'owner' }, { sub: 'o-046' }),
        );
        const head = (await h.parts.logs.head(ref)).seq;
        const refused = async (status: number, r: Promise<{ status: number; text: string }>) => {
          const x = await r;
          expect(x.status, x.text).toBe(status);
        };
        const good = { asset: mine, mode: 'uploaded' };

        // No consent on record: refused (FRW-044 criterion 3).
        await refused(403, sign(doc, 'p1', F.sig, good));
        expect((await accept(doc, 'p1')).status).toBe(200);
        // A field of another role, a field hidden by a rule, a field of another kind, no such field.
        await refused(403, sign(doc, 'p1', F.sigLandlord, good));
        await refused(403, sign(doc, 'p1', F.hidden, good));
        await refused(403, sign(doc, 'p1', F.text, good));
        await refused(403, sign(doc, 'p1', F.dateTenant, good));
        await refused(404, sign(doc, 'p1', id(99), good));
        // A participant who is not active: p2 comes second, so cannot sign yet, consent or not.
        expect((await accept(doc, 'p2')).status).toBe(200);
        await refused(403, sign(doc, 'p2', F.sigLandlord, good));
        // The image: another person's, not an asset, a bad mode, extra members.
        await refused(403, sign(doc, 'p1', F.sig, { asset: ownersAsset, mode: 'uploaded' }));
        await refused(400, sign(doc, 'p1', F.sig, { asset: 'not-an-asset', mode: 'uploaded' }));
        await refused(400, sign(doc, 'p1', F.sig, { asset: mine, mode: 'scribbled' }));
        await refused(400, sign(doc, 'p1', F.sig, { ...good, imageHash: 'a'.repeat(64) }));
        // The host's service credential does not sign for a person.
        const viaService = await h.call('POST', `/v1/documents/${doc}/fields/${F.sig}/sign`, {
          token: h.serviceJwt(),
          body: good,
        });
        expect(viaService.status).toBe(403);

        expect(await signCommits(ref)).toHaveLength(0);
        expect((await h.parts.logs.head(ref)).seq).toBe(head);
        expect((await values(doc))['tenant.sig']).toBeNull();
        expect(
          (await h.parts.evidence!.list(h.tenant, doc)).filter((r) => r.item === 'signed'),
        ).toHaveLength(0);
        expect(h.events.of('dep.workflow.field_completed.v1')).toHaveLength(0);
      },
      60_000,
    );

    it.skipIf(skip)(
      'writes the signature and the dateSigned fields of the role in one commit with origin sign, records the evidence and raises field_completed (criteria 3, 4 and 5)',
      async () => {
        const { doc, ref } = await workflow();
        const tok = token(doc, 'p1');
        const sigAsset = await readyAsset(doc, tok);
        const initialsAsset = await readyAsset(doc, tok);
        expect((await accept(doc, 'p1')).status).toBe(200);
        const surrogate = (await h.parts.users.resolve(h.tenant, 'sub-p1')).surrogate;

        const key = 'sign-key-046-1';
        const first = await sign(
          doc,
          'p1',
          F.sig,
          { asset: sigAsset, mode: 'drawn' },
          { 'idempotency-key': key },
        );
        expect(first.status, first.text).toBe(200);
        const commits = await signCommits(ref);
        expect(commits).toHaveLength(1);
        const commit = commits[0]!;
        expect(first.json).toMatchObject({
          field: F.sig,
          value: { asset: sigAsset, mode: 'drawn' },
          seq: commit.seq,
        });
        expect(commit.user).toBe(surrogate);

        // One commit: the signature, and the dateSigned field of the tenant role, not the landlord's.
        const v = await values(doc);
        expect(v['tenant.sig']).toEqual({ asset: sigAsset, mode: 'drawn' });
        expect(v['tenant.date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(v['landlord.date']).toBeNull();
        expect(v['tenant.initials']).toBeNull();
        const stored = await h.parts.logs.read(ref, commit.seq, commit.seq);
        expect(JSON.stringify(stored[0]!.steps)).toContain(sigAsset);
        expect(JSON.stringify(stored[0]!.steps)).toContain(v['tenant.date'] as string);

        // Evidence: the seq and the chain hash of the signing commit, the mode and the image hash
        // the service computed from the stored bytes (criterion 4).
        const row = (await h.parts.assetRegistry.get(h.tenant, sigAsset))!;
        const evidence = (await h.parts.evidence!.list(h.tenant, doc)).filter(
          (r) => r.item === 'signed',
        );
        expect(evidence).toHaveLength(1);
        const fact = (
          evidence[0]!.evidence.items as {
            signings: Array<Record<string, unknown>>;
          }
        ).signings[0]!;
        const head = await h.parts.logs.head(ref);
        // A control commit that anchors the salted hash of the evidence follows the signing, and is the
        // head (FRW-041).
        const anchors = (await h.parts.logs.read(ref)).filter((c) => c.evidence !== undefined);
        expect(anchors).toHaveLength(1);
        expect(anchors[0]!.seq).toBeGreaterThan(commit.seq);
        expect(head.seq).toBe(anchors[0]!.seq);
        expect(fact).toMatchObject({
          seq: commit.seq,
          chainHash: first.json.chainHash,
          fieldKey: 'tenant.sig',
          mode: 'drawn',
          imageHash: row.sha256,
        });
        expect(first.json.chainHash).toBe(fact['chainHash']);
        // The hash is that of the bytes the worker stored (it re-encodes the upload), not of the upload.
        const storedBytes = Buffer.from((await h.service.assets.getFinal(h.tenant, row.sha256!))!);
        expect(createHash('sha256').update(storedBytes).digest('hex')).toBe(fact['imageHash']);
        // The commit attached the image to the document (FRW-045 criterion 3; invariant I4).
        expect((await h.parts.logs.attachedAssets!(ref)).get(sigAsset)).toBe(commit.seq);
        const raised = h.events
          .of('dep.workflow.field_completed.v1')
          .filter((e) => e.subject === doc);
        expect(raised).toHaveLength(1);
        expect(raised[0]!.data).toMatchObject({
          participant: 'p1',
          document: doc,
          seq: commit.seq,
          chainHead: fact['chainHash'],
        });

        // The same request repeated with the same Idempotency-Key, and without one: one commit, the
        // same answer, no second event and no second evidence row (criterion 5).
        const again = await sign(
          doc,
          'p1',
          F.sig,
          { asset: sigAsset, mode: 'drawn' },
          { 'idempotency-key': key },
        );
        expect(again.status, again.text).toBe(200);
        expect(again.json).toEqual(first.json);
        const bare = await sign(doc, 'p1', F.sig, { asset: sigAsset, mode: 'drawn' });
        expect(bare.status, bare.text).toBe(200);
        expect(bare.json).toEqual(first.json);
        expect(await signCommits(ref)).toHaveLength(1);
        expect(
          (await h.parts.evidence!.list(h.tenant, doc)).filter((r) => r.item === 'signed'),
        ).toHaveLength(1);
        expect(
          h.events.of('dep.workflow.field_completed.v1').filter((e) => e.subject === doc),
        ).toHaveLength(1);
        // Another image for the same field is refused: it is signed.
        const other = await sign(doc, 'p1', F.sig, { asset: initialsAsset, mode: 'drawn' });
        expect(other.status, other.text).toBe(409);

        // Initials are a second signing with their own commit.
        const ini = await sign(doc, 'p1', F.initials, { asset: initialsAsset, mode: 'typed' });
        expect(ini.status, ini.text).toBe(200);
        expect(await signCommits(ref)).toHaveLength(2);
        expect((await values(doc))['tenant.initials']).toEqual({
          asset: initialsAsset,
          mode: 'typed',
        });
      },
      60_000,
    );

    it.skipIf(skip)(
      'sets dateSigned to the date in the workflow time zone, from the server clock (criterion 7)',
      async () => {
        // Move the server clock to 23:30 UTC. In Tokyo (UTC+9) it is already 08:30 of the next day.
        const now = h.now();
        const target = Math.ceil((now - 23.5 * 3_600_000) / DAY) * DAY + 23.5 * 3_600_000;
        h.advance(target - now);
        const utcDate = new Date(h.now()).toISOString().slice(0, 10);
        const tokyoDate = new Date(h.now() + 9 * 3_600_000).toISOString().slice(0, 10);
        expect(tokyoDate).not.toBe(utcDate);

        const { doc } = await workflow('Asia/Tokyo');
        const tok = token(doc, 'p1');
        const asset = await readyAsset(doc, tok);
        expect((await accept(doc, 'p1')).status).toBe(200);
        const r = await sign(doc, 'p1', F.sig, { asset, mode: 'typed' });
        expect(r.status, r.text).toBe(200);
        // The client names no date; the stored one is the Tokyo date, not the UTC one.
        expect((await values(doc))['tenant.date']).toBe(tokyoDate);
        expect(r.json.dateSigned).toEqual({ fields: [F.dateTenant], date: tokyoDate });
      },
      60_000,
    );
  });
}
