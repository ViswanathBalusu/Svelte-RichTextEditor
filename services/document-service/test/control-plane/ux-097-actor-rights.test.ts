// UX-097 criterion 4 (owner decision 261; ADR 0410 option 2; 05 §3.2): a content-changing service
// call that names a user is refused where no role could allow the change, and the refusal is not
// widened by the service credential. The role stays the host's word (it is not a claim the service
// holds). Prefill into a field of an approved region, and into a region leased to someone else, are
// refused for the named user; the lease holder named as the actor is accepted. A refused call leaves
// the document unchanged and writes no commit audit entry. Runs on the in-memory store and on
// PostgreSQL when the integration environment is up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';
const fid = 'fa00000000000001';

/** The regions fixture with a text field inside the region `rOpen` (policy `inherit`). */
function fieldInRegion(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const region = d.doc.content[1]!.content.find(
    (c) => (c['attrs'] as { id?: string } | undefined)?.id === OPEN,
  ) as { content: unknown[] };
  region.content.push({
    type: 'paragraph',
    attrs: { id: 'pPrefill00000001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: fid,
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
  describe(`the rights of the user a service call names (${storage}; UX-097 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    const prefill = async (doc: string, actor: string | null, value: string) => {
      const service = h.serviceJwt();
      const values = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
      return h.call('PATCH', `/v1/documents/${doc}/field-values`, {
        token: service,
        body: { values: { 'tenant.name': value } },
        headers: {
          'if-match': values.headers.get('etag')!,
          ...(actor ? { 'DEP-Actor': actor } : {}),
        },
      });
    };
    const valueOf = async (doc: string): Promise<unknown> => {
      const r = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: h.serviceJwt() });
      return (r.json as { values: Record<string, unknown> }).values['tenant.name'] ?? null;
    };
    const audited = async (doc: string) =>
      (await h.parts.audit!.query(h.tenant, { kind: 'commit.service', limit: 50 })).filter(
        (e) => e.doc === doc,
      );

    it.skipIf(skip)(
      'refuses a prefill into an approved region, whoever is named, and changes nothing',
      async () => {
        const doc = await h.createDocument({ content: fieldInRegion() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-097' });
        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        const approved = await h.call('PUT', `/v1/documents/${doc}/regions/${OPEN}/state`, {
          token: owner,
          body: { state: 'approved' },
          headers: { 'If-Match': grants.headers.get('etag')! },
        });
        expect(approved.status, approved.text).toBe(200);

        const named = await prefill(doc, 'olivia', 'Grace');
        expect(named.status, named.text).toBe(409);
        expect(named.json.code ?? named.json.error?.code).toBe('conflict');
        expect(await valueOf(doc)).toBeNull();
        expect(await audited(doc)).toHaveLength(0);
      },
    );

    it.skipIf(skip)(
      'refuses a prefill into a region leased to someone else, and accepts the lease holder as the actor',
      async () => {
        const doc = await h.createDocument({ content: fieldInRegion() });
        const bob = h.userToken({ [doc]: 'editor' }, { sub: 'bob-097' });
        const lease = await h.call('POST', `/v1/documents/${doc}/regions/${OPEN}/lease`, {
          token: bob,
          body: {},
          headers: { 'Idempotency-Key': `lease-097-${storage}` },
        });
        expect(lease.status, lease.text).toBe(201);

        const other = await prefill(doc, 'olivia', 'Grace');
        expect(other.status, other.text).toBe(409);
        expect(await valueOf(doc)).toBeNull();
        expect(await audited(doc)).toHaveLength(0);

        const holder = await prefill(doc, 'bob-097', 'Grace');
        expect(holder.status, holder.text).toBe(200);
        expect(await valueOf(doc)).toBe('Grace');
        expect(await audited(doc)).toHaveLength(1);
      },
    );

    it.skipIf(skip)(
      'refuses a replacement that changes an approved region, with the actor named or not',
      async () => {
        const doc = await h.createDocument({ content: fieldInRegion() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-097r' });
        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        const approved = await h.call('PUT', `/v1/documents/${doc}/regions/${OPEN}/state`, {
          token: owner,
          body: { state: 'approved' },
          headers: { 'If-Match': grants.headers.get('etag')! },
        });
        expect(approved.status, approved.text).toBe(200);
        const changed = JSON.stringify(fieldInRegion()).replace(
          '"label":"Name"',
          '"label":"Other"',
        );
        for (const actor of ['olivia', null]) {
          const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
          const refused = await h.call('PUT', `/v1/documents/${doc}/content`, {
            token: h.apiKey,
            body: JSON.parse(changed),
            headers: {
              'If-Match': head.headers.get('etag')!,
              ...(actor ? { 'DEP-Actor': actor } : {}),
            },
          });
          expect(refused.status, refused.text).toBe(409);
        }
        expect(await audited(doc)).toHaveLength(0);
      },
    );
  });
}
