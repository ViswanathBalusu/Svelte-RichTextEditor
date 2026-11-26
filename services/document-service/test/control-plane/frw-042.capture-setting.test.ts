// FRW-042 through the real service (lane w4, 2026-11-26): the tenant setting for keeping the IP
// address and the user agent in participant evidence, changed through
// `PUT /workflow/capture-settings` with the service credential. With the setting off, a participant's
// view, consent, signing and completion keep neither item and every other item; a change is audited
// with its actor and time, applies to the events after it and rewrites nothing stored; a caller
// without the service credential is refused. Memory storage and, when the test environment is up,
// PostgreSQL in Podman. docs/adr/0426-w4-FRW-042-capture-setting-api.md (proposed).
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
const SIG = 'fd00000000000042';
const TEXT_ID = 'esign-consent';
const VERSION = 1;
const TEXT = 'I agree to sign electronically. Test text only.';
const PATH = '/v1/workflow/capture-settings';

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
    attrs: { id: 'pCapture00000042' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: SIG,
          key: 'tenant.sig',
          kind: 'signature',
          label: 'sig',
          assignee: 'tenant',
          required: false,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string, participants: unknown[]) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c42',
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
  describe(`the capture setting of the tenant (${storage}; FRW-042)`, async () => {
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

    const admin = () => h.serviceJwt();
    const read = () => h.call('GET', PATH, { token: admin() });
    const put = (value: unknown, etag: string) =>
      h.call('PUT', PATH, {
        token: admin(),
        body: { captureNetworkIdentity: value },
        headers: { 'if-match': etag },
      });
    const token = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });
    const agent = { 'user-agent': 'FrwTest/42' };

    async function workflow(kind: 'signer' | 'filler') {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-042-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, [{ id: 'p1', roles: ['tenant'], kind, order: 1, sub: 'sub-p1' }]),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(sent.status, sent.text).toBe(200);
      return { doc, owner };
    }

    async function open(doc: string, owner: string, tok: string) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, {
        headers: { 'user-agent': 'FrwTest/42' },
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

    const consent = (doc: string, tok: string) =>
      h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/consent`, {
        token: tok,
        body: {},
        headers: agent,
      });
    const complete = (doc: string, tok: string) =>
      h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
        token: tok,
        body: {},
        headers: agent,
      });
    const rowsOf = async (doc: string) =>
      (await h.parts.evidence!.list(h.tenant, doc)).map((r) => ({
        item: r.item,
        facts: r.evidence as unknown as Facts,
      }));

    // The tests change the one setting of the tenant, so they run in order.
    it.skipIf(skip)('is on by default and both items are recorded (criterion 3)', async () => {
      const r = await read();
      expect(r.status, r.text).toBe(200);
      expect(r.json).toEqual({ captureNetworkIdentity: true });
      expect(r.headers.get('etag')).toBe('"0"');
      const { doc, owner } = await workflow('filler');
      const tok = token(doc, 'p1');
      await open(doc, owner, tok);
      expect((await consent(doc, tok)).status).toBe(200);
      expect((await complete(doc, tok)).status).toBe(200);
      const rows = await rowsOf(doc);
      expect(rows.map((x) => x.item)).toEqual(['viewed', 'consent', 'completed']);
      for (const x of rows) {
        expect(x.facts.ipAddress, x.item).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
        expect(x.facts.userAgent, x.item).toBe('FrwTest/42');
      }
    });

    it.skipIf(skip)('refuses a caller without the service credential (criterion 4)', async () => {
      const owner = h.userToken({}, { sub: 'owner-042-credential' });
      const participant = token('0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c99', 'p1');
      for (const tok of [owner, participant]) {
        const g = await h.call('GET', PATH, { token: tok });
        expect(g.status, g.text).toBe(403);
        const p = await h.call('PUT', PATH, {
          token: tok,
          body: { captureNetworkIdentity: false },
          headers: { 'if-match': '"0"' },
        });
        expect(p.status, p.text).toBe(403);
      }
      const none = await h.call('PUT', PATH, {
        body: { captureNetworkIdentity: false },
        headers: { 'if-match': '"0"' },
      });
      expect(none.status, none.text).toBe(401);
      // Nothing changed.
      expect((await read()).json).toEqual({ captureNetworkIdentity: true });
    });

    it.skipIf(skip)('refuses a malformed or stale request and changes nothing', async () => {
      for (const body of [{}, { captureNetworkIdentity: 'no' }, { captureNetworkIdentity: false, x: 1 }]) {
        const r = await h.call('PUT', PATH, {
          token: admin(),
          body,
          headers: { 'if-match': '"0"' },
        });
        expect(r.status, JSON.stringify(body) + r.text).toBe(400);
      }
      const stale = await put(false, '"7"');
      expect(stale.status, stale.text).toBe(412);
      expect((await read()).json).toEqual({ captureNetworkIdentity: true });
      expect(await h.parts.audit!.query(h.tenant, { kind: 'capture.setting.changed', limit: 10 })).toHaveLength(0);
    });

    it.skipIf(skip)(
      'audits a change with actor and time, applies to later events only, and rewrites nothing (criterion 2)',
      async () => {
        const { doc, owner } = await workflow('filler');
        const tok = token(doc, 'p1');
        await open(doc, owner, tok);
        expect((await consent(doc, tok)).status).toBe(200);
        const before = await rowsOf(doc);
        expect(before.map((x) => x.item)).toEqual(['viewed', 'consent']);

        const t0 = h.now();
        const changed = await h.call('PUT', PATH, {
          token: admin(),
          body: { captureNetworkIdentity: false },
          headers: { 'if-match': '"0"', 'dep-actor': 'admin-surrogate-42' },
        });
        expect(changed.status, changed.text).toBe(200);
        expect(changed.json).toEqual({ captureNetworkIdentity: false });
        expect(changed.headers.get('etag')).toBe('"1"');
        const t1 = h.now();

        const audit = await h.parts.audit!.query(h.tenant, {
          kind: 'capture.setting.changed',
          limit: 10,
        });
        expect(audit).toHaveLength(1);
        // The actor is the per-tenant surrogate of the user the service names, not the name itself.
        expect(audit[0]!.actor).toMatch(/^[0-9a-f-]{36}$/);
        expect(audit[0]!.actor).not.toContain('admin-surrogate-42');
        // The time is the service's own, taken at the change (the PostgreSQL parts keep the system
        // clock, the memory parts the harness clock: both are within a minute of the call).
        expect(audit[0]!.at).toBeGreaterThanOrEqual(t0 - 60_000);
        expect(audit[0]!.at).toBeLessThanOrEqual(t1 + 60_000);
        expect(audit[0]!.data).toMatchObject({
          from: { captureNetworkIdentity: true },
          to: { captureNetworkIdentity: false },
          version: 1,
        });

        // A change to the value in force is not a change: no second entry, the version stays.
        const same = await put(false, '"1"');
        expect(same.status, same.text).toBe(200);
        expect(same.headers.get('etag')).toBe('"1"');
        expect(
          await h.parts.audit!.query(h.tenant, { kind: 'capture.setting.changed', limit: 10 }),
        ).toHaveLength(1);

        // The completion after the change has neither item; the rows before it are as they were.
        expect((await complete(doc, tok)).status).toBe(200);
        const after = await rowsOf(doc);
        expect(after.map((x) => x.item)).toEqual(['viewed', 'consent', 'completed']);
        expect(after.slice(0, 2)).toEqual(before);
        expect(after[0]!.facts.ipAddress).toBeTypeOf('string');
        expect(after[1]!.facts.userAgent).toBe('FrwTest/42');
        expect(after[2]!.facts.ipAddress ?? null).toBeNull();
        expect(after[2]!.facts.userAgent ?? null).toBeNull();
        expect(after[2]!.facts.items['completedAtMs']).toBeTypeOf('number');
      },
      60_000,
    );

    it.skipIf(skip)(
      'with the setting off, the view, consent, signing and completion keep no address and no agent, and every other item (criterion 1)',
      async () => {
        expect((await read()).json).toEqual({ captureNetworkIdentity: false });
        const { doc, owner } = await workflow('signer');
        const tok = token(doc, 'p1');
        await open(doc, owner, tok);
        expect((await consent(doc, tok)).status).toBe(200);
        const asset = await readyAsset(doc, tok);
        const signed = await h.call('POST', `/v1/documents/${doc}/fields/${SIG}/sign`, {
          token: tok,
          body: { asset, mode: 'drawn' },
          headers: agent,
        });
        expect(signed.status, signed.text).toBe(200);
        expect((await complete(doc, tok)).status).toBe(200);

        const rows = await rowsOf(doc);
        expect(rows.map((x) => x.item)).toEqual(['viewed', 'consent', 'signed', 'completed']);
        for (const x of rows) {
          expect(x.facts.ipAddress ?? null, x.item).toBeNull();
          expect(x.facts.userAgent ?? null, x.item).toBeNull();
        }
        const stored = JSON.stringify(rows);
        expect(stored).not.toContain('FrwTest/42');
        expect(stored).not.toMatch(/127\.0\.0\.1|::1/);
        // The other items continue to be recorded.
        const [viewed, consented, signing, completed] = rows.map((x) => x.facts.items) as [
          Facts['items'],
          Facts['items'],
          Facts['items'],
          Facts['items'],
        ];
        expect(viewed['session']).toBeTypeOf('string');
        expect(viewed['viewedAtMs']).toBeTypeOf('number');
        expect(consented['consent']).toMatchObject({ textId: TEXT_ID, version: VERSION });
        expect((signing['signings'] as unknown[]).length).toBe(1);
        expect(completed['completedAtMs']).toBeTypeOf('number');
      },
      90_000,
    );

    it.skipIf(skip)('records both items again after the setting is switched on', async () => {
      const on = await put(true, '"1"');
      expect(on.status, on.text).toBe(200);
      expect(on.headers.get('etag')).toBe('"2"');
      const { doc, owner } = await workflow('filler');
      const tok = token(doc, 'p1');
      await open(doc, owner, tok);
      const rows = await rowsOf(doc);
      expect(rows[0]!.facts.userAgent).toBe('FrwTest/42');
    });
  });
}
