// FRW-044 through the real service (lane w4, 2026-11-18): the consent endpoint of a participant,
// `POST /documents/{id}/workflow/participants/{pid}/consent`. The service holds the text, computes
// the hash and takes the time; the client supplies none of them. The REST routes on memory storage
// and, when the test environment is up, PostgreSQL in Podman. The screen with the text and the
// accept control (criteria 1, 4 and 5) is the editor's and is not tested here.
// docs/adr/0395-w4-FRW-044-consent-text-store.md (proposed).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentVerdict, MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
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
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

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
    attrs: { id: 'pFields000000003' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'ffTenant00000001',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string, consent: unknown = { textId: TEXT_ID, version: VERSION }) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cb1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  ...(consent === null ? {} : { consent }),
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
    { id: 'p3', roles: ['landlord'], kind: 'approver', order: 3, sub: 'sub-p3' },
    {
      id: 'p4',
      roles: ['landlord'],
      kind: 'signer',
      order: 4,
      sub: 'sub-p4',
      auth: { require: ['access_code'] },
    },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`consent of a participant (${storage}; FRW-044)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    let h: Harness;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage, { parts: { consentTexts: texts } });
        texts.put(h.tenant, TEXT_ID, VERSION, TEXT);
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    async function workflow(opts: { send?: boolean; consent?: unknown } = {}) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-044-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, opts.consent),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      if (opts.send !== false) {
        const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(r.status, r.text).toBe(200);
      }
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }
    const token = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });
    const consent = (doc: string, pid: string, tok = token(doc, pid), body?: unknown) =>
      h.call('POST', `/v1/documents/${doc}/workflow/participants/${pid}/consent`, {
        token: tok,
        body: body ?? {},
      });
    const rows = async (doc: string, pid: string) =>
      (await h.parts.evidence!.list(h.tenant, doc)).filter(
        (r) => r.participant === pid && r.item === 'consent',
      );

    it.skipIf(skip)(
      'records the text identifier, the version, the hash the service computed and the server time (criterion 2)',
      async () => {
        const { doc } = await workflow();
        h.advance(1500);
        const before = h.now();
        const r = await consent(doc, 'p1');
        expect(r.status, r.text).toBe(200);
        const kept = await rows(doc, 'p1');
        expect(kept).toHaveLength(1);
        // The time is the service clock at the request: not before the call and not far after it.
        const atMs = (kept[0]!.evidence.items as { consent: { atMs: number } }).consent.atMs;
        expect(atMs).toBeGreaterThanOrEqual(before);
        expect(atMs).toBeLessThan(before + 60_000);
        expect(r.json).toEqual({
          textId: TEXT_ID,
          version: VERSION,
          hash: sha256(TEXT),
          acceptedAt: new Date(atMs).toISOString(),
        });
        expect(kept[0]!.evidence.items).toMatchObject({
          consent: { textId: TEXT_ID, version: VERSION, hash: sha256(TEXT), atMs },
        });
        // The text itself is not kept in the evidence, only its hash.
        expect(JSON.stringify(kept[0]!.evidence)).not.toContain(TEXT);

        // The same acceptance again changes nothing.
        const again = await consent(doc, 'p1');
        expect(again.status, again.text).toBe(200);
        expect(again.json).toEqual(r.json);
        expect(await rows(doc, 'p1')).toHaveLength(1);
      },
    );

    it.skipIf(skip)('takes no hash, no time and no text from the client', async () => {
      const { doc } = await workflow();
      for (const body of [
        { hash: 'a'.repeat(64) },
        { textHash: sha256('another text') },
        { acceptedAt: '2020-01-01T00:00:00Z' },
        { text: 'another text' },
        [],
        'accept',
      ]) {
        const r = await consent(doc, 'p1', undefined, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.json.code).toBe('validation_failed');
      }
      expect(await rows(doc, 'p1')).toHaveLength(0);
      // An empty object is allowed, and the hash is still the service's.
      const ok = await consent(doc, 'p1', undefined, {});
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json.hash).toBe(sha256(TEXT));
    });

    it.skipIf(skip)(
      'is the participant’s own act, and only for one who accepts a consent',
      async () => {
        const { doc, owner } = await workflow();
        // Another participant's token, the owner's token and the host's service credential.
        expect((await consent(doc, 'p1', token(doc, 'p2'))).status).toBe(403);
        expect((await consent(doc, 'p1', owner)).status).toBe(403);
        expect((await consent(doc, 'p1', h.serviceJwt())).status).toBe(403);
        expect((await consent(doc, 'nobody', owner)).status).toBe(404);
        // An approver has no consent text to accept (ADR 0250, item 1).
        const approver = await consent(doc, 'p3');
        expect(approver.status, approver.text).toBe(409);
        expect(await rows(doc, 'p3')).toHaveLength(0);
        // A participant whose access code is not yet verified cannot accept.
        const waiting = await consent(doc, 'p4');
        expect(waiting.status, waiting.text).toBe(409);
        expect(await rows(doc, 'p4')).toHaveLength(0);
        expect(await rows(doc, 'p1')).toHaveLength(0);
      },
    );

    it.skipIf(skip)(
      'is refused while the workflow is a draft, without a consent member, and without a held text',
      async () => {
        const draft = await workflow({ send: false });
        expect((await consent(draft.doc, 'p1')).status).toBe(409);
        const none = await workflow({ consent: null });
        const noConsent = await consent(none.doc, 'p1');
        expect(noConsent.status, noConsent.text).toBe(409);
        const unknown = await workflow({ consent: { textId: 'not-held', version: 1 } });
        const missing = await consent(unknown.doc, 'p1');
        expect(missing.status, missing.text).toBe(409);
        for (const w of [draft, none, unknown]) expect(await rows(w.doc, 'p1')).toHaveLength(0);
      },
    );

    it.skipIf(skip)(
      'tells a sign request whether the acceptance on record still stands (the check of criterion 3)',
      async () => {
        const { doc, ref } = await workflow();
        const deps = {
          workflows: h.parts.workflows!,
          evidence: h.parts.evidence!,
          texts,
          now: () => h.now(),
        };
        // No acceptance: refused.
        expect(await consentVerdict(deps, ref, 'p1')).toMatchObject({ ok: false });
        expect((await consent(doc, 'p1')).status).toBe(200);
        expect(await consentVerdict(deps, ref, 'p1')).toEqual({ ok: true });
        // Another participant has none.
        expect(await consentVerdict(deps, ref, 'p2')).toMatchObject({ ok: false });
        // The text changes under the same identifier and version: the earlier acceptance is refused.
        texts.put(h.tenant, TEXT_ID, VERSION, `${TEXT} Changed.`);
        try {
          const changed = await consentVerdict(deps, ref, 'p1');
          expect(changed).toMatchObject({ ok: false });
          expect((changed as { reason: string }).reason).toContain('changed');
        } finally {
          texts.put(h.tenant, TEXT_ID, VERSION, TEXT);
        }
        expect(await consentVerdict(deps, ref, 'p1')).toEqual({ ok: true });
      },
    );

    // The text reaches the client (criterion 1): `GET .../consent`, for the participant it is bound to.
    const read = (doc: string, pid: string, tok = token(doc, pid)) =>
      h.call('GET', `/v1/documents/${doc}/workflow/participants/${pid}/consent`, { token: tok });

    it.skipIf(skip)(
      'gives the participant the text the workflow names, and whether they accepted it (criterion 1)',
      async () => {
        const { doc } = await workflow();
        const first = await read(doc, 'p1');
        expect(first.status, first.text).toBe(200);
        // The text is the service's, in full, with its identifier and version; not yet accepted.
        expect(first.json).toEqual({
          textId: TEXT_ID,
          version: VERSION,
          text: TEXT,
          acceptedAt: null,
        });
        expect(first.headers.get('cache-control')).toBe('no-store');
        // Reading writes nothing.
        expect(await rows(doc, 'p1')).toHaveLength(0);

        const accepted = await consent(doc, 'p1');
        expect(accepted.status, accepted.text).toBe(200);
        const after = await read(doc, 'p1');
        expect(after.json).toEqual({
          textId: TEXT_ID,
          version: VERSION,
          text: TEXT,
          acceptedAt: (accepted.json as { acceptedAt: string }).acceptedAt,
        });
        // Another participant has accepted nothing.
        expect((await read(doc, 'p2')).json).toMatchObject({ acceptedAt: null });

        // The text changes under the same identifier and version: the acceptance no longer counts.
        texts.put(h.tenant, TEXT_ID, VERSION, `${TEXT} Changed.`);
        try {
          expect((await read(doc, 'p1')).json).toMatchObject({
            text: `${TEXT} Changed.`,
            acceptedAt: null,
          });
        } finally {
          texts.put(h.tenant, TEXT_ID, VERSION, TEXT);
        }
      },
    );

    it.skipIf(skip)(
      'shows the text to nobody but the participant it is bound to, and not when there is nothing to accept',
      async () => {
        const { doc, owner } = await workflow();
        for (const [who, tok] of [
          ['another participant', token(doc, 'p2')],
          ['the owner', owner],
          ['the host service', h.serviceJwt()],
        ] as const) {
          const r = await read(doc, 'p1', tok);
          expect(r.status, `${who} ${r.text}`).toBe(403);
          expect(r.text).not.toContain(TEXT);
        }
        // An approver accepts nothing, so is shown nothing; an access code not yet given holds it back.
        expect((await read(doc, 'p3')).status).toBe(409);
        expect((await read(doc, 'p4')).status).toBe(409);
        expect((await read(doc, 'nobody', owner)).status).toBe(404);
        // A draft, a workflow with no consent and a missing text are conflicts, as for the acceptance.
        const draft = await workflow({ send: false });
        expect((await read(draft.doc, 'p1')).status).toBe(409);
        const none = await workflow({ consent: null });
        expect((await read(none.doc, 'p1')).status).toBe(409);
        const unknown = await workflow({ consent: { textId: 'not-held', version: 1 } });
        expect((await read(unknown.doc, 'p1')).status).toBe(409);
      },
    );
  });
}
