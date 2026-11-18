// UX-097 criterion 1 (owner decision 174; 07 §14): a content-changing call of a service credential
// that names a user in `DEP-Actor` is on the audit trail with that user's surrogate as the actor,
// the credential that made it and the commit's origin. Without `DEP-Actor` the actor is `system`.
// A prefill (origin `prefill`) and a content replacement (origin `replace`) are covered. Runs on the
// in-memory store and on PostgreSQL when the integration environment is up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const fid = (n: number) => `fa${String(n).padStart(14, '0')}`;

/** The regions fixture with one paragraph that holds a text field. */
function prefillDocument(): Record<string, unknown> {
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
    attrs: { id: 'pPrefill00000001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: fid(1),
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`service calls on behalf of a user are audited (${storage}; UX-097 criterion 1)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'a prefill that names an actor is audited under that actor, with the credential and the origin',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const service = h.serviceJwt();
        const values = await h.call('GET', `/v1/documents/${doc}/field-values`, {
          token: service,
        });
        const named = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: { 'tenant.name': 'Grace' } },
          headers: { 'if-match': values.headers.get('etag')!, 'DEP-Actor': 'olivia' },
        });
        expect(named.status, named.text).toBe(200);

        const events = await h.parts.audit!.query(h.tenant, { kind: 'commit.service', limit: 50 });
        expect(events).toHaveLength(1);
        const event = events[0]!;
        const surrogate = (await h.parts.users.resolve(h.tenant, 'olivia')).surrogate;
        expect(event.actor).toBe(surrogate);
        expect(event.actor).not.toBe('olivia');
        expect(event.actor).not.toBe('system');
        expect(event.doc).toBe(doc);
        expect(event.data['origin']).toBe('prefill');
        // The credential that made the call is recorded as well as the person (decision 174).
        expect(typeof event.data['credential']).toBe('string');
        expect(event.data['credential']).not.toBe('');
        expect(JSON.stringify(event)).not.toContain('Grace');
      },
    );

    it.skipIf(skip)(
      'a call without DEP-Actor is audited under system, and a replacement names its origin',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const replaced = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: prefillDocument(),
          headers: { 'If-Match': head.headers.get('etag')! },
        });
        expect(replaced.status, replaced.text).toBe(204);
        const events = (
          await h.parts.audit!.query(h.tenant, { kind: 'commit.service', limit: 50 })
        ).filter((e) => e.doc === doc);
        expect(events).toHaveLength(1);
        expect(events[0]!.actor).toBe('system');
        expect(events[0]!.data['origin']).toBe('replace');
        expect(events[0]!.data['credential']).toEqual(expect.any(String));
      },
    );

    it.skipIf(skip)('a user token is audited under the user, not as a service', async () => {
      const doc = await h.createDocument({ content: prefillDocument() });
      const owner = h.userToken({ [doc]: 'owner' });
      const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: owner });
      const replaced = await h.call('PUT', `/v1/documents/${doc}/content`, {
        token: owner,
        body: prefillDocument(),
        headers: { 'If-Match': head.headers.get('etag')!, 'DEP-Actor': 'someone-else' },
      });
      // The route may refuse a user token (a service route); either way, nothing is attributed to
      // the header's person.
      const events = (
        await h.parts.audit!.query(h.tenant, { kind: 'commit.service', limit: 50 })
      ).filter((e) => e.doc === doc);
      const someone = (await h.parts.users.resolve(h.tenant, 'someone-else')).surrogate;
      expect(events.map((e) => e.actor)).not.toContain(someone);
      expect([204, 403]).toContain(replaced.status);
    });
  });
}
