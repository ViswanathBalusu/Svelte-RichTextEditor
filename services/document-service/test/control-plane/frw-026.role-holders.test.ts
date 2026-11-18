// FRW-026 criterion 3 through the real service: a person bound to two roles holds both (`access.fill`
// lists both roles and both sets of fields are theirs), and a role bound to two participants is
// held by either of them (either may fill that role's fields). The real token service and data
// plane, a real WebSocket client, host-signed tokens with the role `filler` (FRW-038), memory
// storage and, when the test environment is up, PostgreSQL in Podman.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TENANT_FIELD = 'ffTenant00000001';
const LANDLORD_FIELD = 'ffLandlord000001';

function field(id: string, key: string, assignee: string): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: { id: `p${id.slice(1)}` },
    content: [
      {
        type: 'form_field',
        attrs: { id, key, kind: 'text', label: key, assignee, required: false, value: null },
      },
    ],
  };
}

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  d.doc.content[1]!.content.push(
    field(TENANT_FIELD, 'tenant.name', 'tenant'),
    field(LANDLORD_FIELD, 'landlord.name', 'landlord'),
  );
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cc3',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    // One person who holds both roles, and a second person who holds the tenant role as well. All
    // three act at once (order 1).
    { id: 'both', roles: ['tenant', 'landlord'], kind: 'filler', order: 1, sub: 'sub-both' },
    { id: 'tenant2', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-tenant2' },
    { id: 'landlord', roles: ['landlord'], kind: 'filler', order: 1, sub: 'sub-landlord' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`roles and their holders (${storage}; FRW-026 criterion 3)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const tree = () => schema.nodeFromJSON((document() as { doc: unknown }).doc);
    const set = (id: string, value: string) => ({
      stepType: 'attr',
      pos: posOf(tree(), id),
      attr: 'value',
      value,
    });

    async function sent() {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-026-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(r.status, r.text).toBe(200);
      return { doc, ref: { tenant: h.tenant, doc } };
    }

    async function connect(doc: string, sub: string, wfp: string) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      const w = await c.hello(h.userToken({ [doc]: 'filler' }, { sub, wfp }));
      expect(w.t, JSON.stringify(w.d)).toBe('welcome');
      const o = await c.open(1, doc);
      expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
      return { c, fill: (o.d as { access: { fill: unknown } }).access.fill };
    }

    const base = async (ref: { tenant: string; doc: string }) => (await h.parts.logs.head(ref)).seq;

    it.skipIf(skip)(
      'gives a person bound to two roles both roles, and both sets of fields (criterion 3, first half)',
      async () => {
        const { doc, ref } = await sent();
        const { c, fill } = await connect(doc, 'sub-both', 'both');
        expect(fill).toMatchObject({ participant: 'both', active: true });
        expect((fill as { roles: string[] }).roles.sort()).toEqual(['landlord', 'tenant']);
        // A field of each role is theirs.
        for (const [id, value] of [
          [TENANT_FIELD, 'Ada'],
          [LANDLORD_FIELD, 'Bea'],
        ] as const) {
          const ack = await c.submit(1, { base: await base(ref), steps: [set(id, value)] });
          expect(ack.t, `${id}: ${JSON.stringify(ack)}`).toBe('sync.ack');
        }
      },
    );

    it.skipIf(skip)(
      'lets either of two participants bound to a role fill that role’s fields, and no field of another role (criterion 3, second half)',
      async () => {
        const { doc, ref } = await sent();
        const first = await connect(doc, 'sub-both', 'both');
        const second = await connect(doc, 'sub-tenant2', 'tenant2');
        expect(second.fill).toMatchObject({ participant: 'tenant2', roles: ['tenant'] });
        // Either fills the tenant's field; the one who comes second changes what the first wrote.
        const a = await second.c.submit(1, {
          base: await base(ref),
          steps: [set(TENANT_FIELD, 'Cy')],
        });
        expect(a.t, JSON.stringify(a)).toBe('sync.ack');
        const b = await first.c.submit(1, {
          base: await base(ref),
          steps: [set(TENANT_FIELD, 'Di')],
        });
        expect(b.t, JSON.stringify(b)).toBe('sync.ack');
        // The tenant-only participant has no right to the landlord's field.
        const refused = await second.c.submit(1, {
          base: await base(ref),
          steps: [set(LANDLORD_FIELD, 'Ed')],
        });
        expect(refused.t).toBe('sync.reject');
      },
    );
  });
}
