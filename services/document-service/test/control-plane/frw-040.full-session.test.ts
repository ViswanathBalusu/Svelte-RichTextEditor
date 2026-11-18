// FRW-040 through the real service: one participant's whole session (the channel opens, consent,
// two signings, the completion) and what the ledger holds for them afterwards, and a participant who
// completes with nothing to sign (the items of an approver and a cc are in frw-040.participant-evidence.test.ts). Everything the evidence names is
// captured from the connection, the service clock and the stored bytes; a client that puts an
// address, an agent, a time or a hash in a body is refused or ignored. Memory storage and, when the
// test environment is up, PostgreSQL in Podman. docs/adr/0392-w4-FRW-040-participant-evidence.md.
import { createHash } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SIG = 'fd00000000000001';
const INI = 'fd00000000000002';
const DATE = 'fd00000000000003';
const TEXT_ID = 'esign-consent';
const VERSION = 1;
const TEXT = 'I agree to sign electronically. Test text only.';
const FORGED = {
  ipAddress: '203.0.113.77',
  userAgent: 'forged-agent/9',
  atMs: 1,
  viewedAtMs: 1,
  completedAtMs: 1,
  acceptedAt: '1999-01-01T00:00:00.000Z',
  hash: 'b'.repeat(64),
  imageHash: 'c'.repeat(64),
  chainHash: 'd'.repeat(64),
  seq: 1,
};

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
  const ff = (id: string, key: string, kind: string) => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee: 'tenant', required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFull00000000040' },
    content: [
      ff(SIG, 'tenant.sig', 'signature'),
      ff(INI, 'tenant.ini', 'initials'),
      ff(DATE, 'tenant.date', 'dateSigned'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string, participants: unknown[]) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c40',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  consent: { textId: TEXT_ID, version: VERSION },
  participants,
});

interface Facts {
  items: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a participant's whole evidence (${storage}; FRW-040)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    const clients: DepClient[] = [];
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
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const token = (doc: string, pid: string, claims: Record<string, unknown> = {}) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid, ...claims });

    async function workflow(participants: unknown[]) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-040f-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, participants),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(r.status, r.text).toBe(200);
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    /** The participant opens the document, as a browser would: its own user agent only. */
    async function open(doc: string, owner: string, tok: string, agent: string) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, {
        headers: { 'user-agent': agent, 'x-forwarded-for': FORGED.ipAddress },
      });
      clients.push(c);
      expect((await c.hello(tok)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the workflow did not reach in_progress');
    }

    async function readyAsset(doc: string, tok: string): Promise<string> {
      const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token: tok,
        body: { filename: 's.png', mime: 'image/png', size: PNG.length },
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

    const rowsOf = (doc: string) => h.parts.evidence!.list(h.tenant, doc);
    const agent = { 'user-agent': 'FrwTest/40' };

    it.skipIf(skip)(
      'records the session, address, agent, amr, consent, view, each signing and the completion, from the server only (criteria 1, 2, 3 and 5)',
      async () => {
        const { doc, owner } = await workflow([
          { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-p1' },
        ]);
        const tok = token(doc, 'p1', { amr: ['pwd', 'otp'] });
        h.advance(5000);
        const t0 = h.now();
        await open(doc, owner, tok, 'FrwTest/40');

        // Consent: a body that names an address, an agent, a time or a hash is refused or ignored.
        const consentPath = `/v1/documents/${doc}/workflow/participants/p1/consent`;
        const consent = await h.call('POST', consentPath, {
          token: tok,
          body: { ...FORGED },
          headers: agent,
        });
        expect([200, 400], consent.text).toContain(consent.status);
        if (consent.status === 400) {
          const clean = await h.call('POST', consentPath, { token: tok, body: {}, headers: agent });
          expect(clean.status, clean.text).toBe(200);
        }

        // Two signings, each with a forged member refused first, then the honest request.
        const heads: Array<{ seq: number; chain: string; key: string; mode: string }> = [];
        for (const [fid, key, mode] of [
          [SIG, 'tenant.sig', 'drawn'],
          [INI, 'tenant.ini', 'uploaded'],
        ] as const) {
          const asset = await readyAsset(doc, tok);
          for (const [member, value] of Object.entries(FORGED)) {
            const bad = await h.call('POST', `/v1/documents/${doc}/fields/${fid}/sign`, {
              token: tok,
              body: { asset, mode, [member]: value },
            });
            expect(bad.status, `${member} ${bad.text}`).toBe(400);
          }
          const ok = await h.call('POST', `/v1/documents/${doc}/fields/${fid}/sign`, {
            token: tok,
            body: { asset, mode },
            headers: agent,
          });
          expect(ok.status, ok.text).toBe(200);
          // The signing commit, as the route names it: a control commit that anchors the salted hash
          // of the evidence follows it (FRW-041), so the head is no longer the signing.
          heads.push({
            seq: (ok.json as { seq: number }).seq,
            chain: (ok.json as { chainHash: string }).chainHash,
            key,
            mode,
          });
        }

        const completePath = `/v1/documents/${doc}/workflow/participants/p1/complete`;
        const done = await h.call('POST', completePath, {
          token: tok,
          body: { ...FORGED },
          headers: agent,
        });
        expect([200, 400], done.text).toContain(done.status);
        if (done.status === 400) {
          const clean = await h.call('POST', completePath, {
            token: tok,
            body: {},
            headers: agent,
          });
          expect(clean.status, clean.text).toBe(200);
        }
        const t1 = h.now();

        // The ledger: one row for each event, all of this participant's.
        const rows = await rowsOf(doc);
        expect(rows.every((r) => r.participant === 'p1')).toBe(true);
        expect(rows.map((r) => r.item)).toEqual([
          'viewed',
          'consent',
          'signed',
          'signed',
          'completed',
        ]);
        const [viewed, consented, first, second, completed] = rows.map(
          (r) => r.evidence as unknown as Facts,
        ) as [Facts, Facts, Facts, Facts, Facts];

        // Criterion 1: the session, address, agent and `amr` of the connection; the consent's text
        // identifier, version, hash and time; the times of the view and the completion.
        expect(viewed.items['session']).toBeTypeOf('string');
        expect(viewed.items['amr']).toEqual(['pwd', 'otp']);
        expect(viewed.ipAddress).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
        expect(viewed.userAgent).toBe('FrwTest/40');
        expect(consented.items['consent']).toMatchObject({
          textId: TEXT_ID,
          version: VERSION,
          hash: createHash('sha256').update(TEXT).digest('hex'),
        });
        expect(consented.items['amr']).toEqual(['pwd', 'otp']);
        expect(consented.userAgent).toBe('FrwTest/40');
        // Criterion 2: the times are the service clock's, and no forged value is anywhere.
        const at = (n: unknown) => n as number;
        const consentAt = at((consented.items['consent'] as { atMs: number }).atMs);
        expect(at(viewed.items['viewedAtMs'])).toBeGreaterThanOrEqual(t0);
        expect(consentAt).toBeGreaterThanOrEqual(at(viewed.items['viewedAtMs']));
        expect(at(completed.items['completedAtMs'])).toBeGreaterThanOrEqual(consentAt);
        expect(at(completed.items['completedAtMs'])).toBeLessThanOrEqual(t1);
        const stored = JSON.stringify(rows.map((r) => r.evidence));
        for (const forged of [
          '203.0.113.77',
          'forged-agent',
          '1999-01-01',
          'b'.repeat(64),
          'c'.repeat(64),
          'd'.repeat(64),
        ])
          expect(stored).not.toContain(forged);

        // Criterion 5, and the seq and chain hash of criterion 1: each signing is its own event, with
        // the seq of its own commit and the chain hash at it, and how it was adopted.
        const signings = [first, second].map(
          (f) => (f.items['signings'] as Array<Record<string, unknown>>)[0]!,
        );
        expect([first, second].map((f) => (f.items['signings'] as unknown[]).length)).toEqual([
          1, 1,
        ]);
        expect(signings.map((s) => s['seq'])).toEqual(heads.map((x) => x.seq));
        expect(new Set(signings.map((s) => s['seq'])).size).toBe(2);
        expect(signings.map((s) => s['chainHash'])).toEqual(heads.map((x) => x.chain));
        expect(new Set(signings.map((s) => s['chainHash'])).size).toBe(2);
        expect(signings.map((s) => [s['fieldKey'], s['mode']])).toEqual(
          heads.map((x) => [x.key, x.mode]),
        );
        for (const s of signings) {
          expect(at(s['atMs'])).toBeGreaterThanOrEqual(consentAt);
          expect(at(s['atMs'])).toBeLessThanOrEqual(t1);
        }

        // Criterion 3: the image hash is that of the bytes the service stored, not a declared one.
        for (const s of signings) {
          const bytes = await h.service.assets.getFinal(h.tenant, s['imageHash'] as string);
          expect(bytes).toBeDefined();
          expect(createHash('sha256').update(Buffer.from(bytes!)).digest('hex')).toBe(
            s['imageHash'],
          );
        }
      },
      90_000,
    );

    it.skipIf(skip)(
      'records no signing for a participant who completes with nothing to sign',
      async () => {
        const { doc, owner } = await workflow([
          { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
          { id: 'ap', roles: ['tenant'], kind: 'approver', order: 2, sub: 'sub-ap' },
          { id: 'cc', roles: ['tenant'], kind: 'cc', order: 3, sub: 'sub-cc' },
        ]);
        await open(doc, owner, token(doc, 'p1'), 'FrwTest/p1');
        const done = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/complete`,
          {
            token: token(doc, 'p1'),
            body: {},
          },
        );
        expect(done.status, done.text).toBe(200);
        const rows = await rowsOf(doc);
        expect(rows.map((r) => r.item)).toEqual(['viewed', 'completed']);
        for (const r of rows) expect(JSON.stringify(r.evidence)).not.toContain('signings');
      },
      60_000,
    );
  });
}
