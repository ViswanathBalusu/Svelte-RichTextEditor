// FRW-062 through the real service: templates and the creation of a document from one. `/templates`
// lists, creates and reads; `POST /documents` with `template` forks the template document at a
// pinned seq, binds participants to its roles and prefills values in the same call. The real data
// plane applies the prefill commit. Memory storage and, when the test environment is up, PostgreSQL
// in Podman. docs/adr/0406-w4-FRW-062-templates.md (proposed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  skipReason,
  startHarness,
  documentWithRegions,
  type Harness,
  type Storage,
} from './support.ts';

/** A template: roles `tenant` and `landlord`, and two fields of the tenant. */
function templateContent(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  for (const role of ['tenant', 'landlord'])
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#1F77B4' } });
  const field = (id: string, key: string, kind: string) => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee: 'tenant', required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pTemplate0000001' },
    content: [
      field('ftTenantName0001', 'tenant.name', 'text'),
      { type: 'text', text: ' ' },
      field('ftLeaseTotal0001', 'lease.total', 'number'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const person = (id: string, role: string, order: number) => ({
  id,
  roles: [role],
  kind: 'filler',
  order,
  sub: `sub-${id}`,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`templates (${storage}; FRW-062)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, { realDataPlane: true, config: { jobIdleMs: 20 } });
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const service = () => h.serviceJwt();
    const call = (method: string, path: string, body?: unknown, token = service()) =>
      h.call(method, `/v1${path}`, { token, ...(body !== undefined ? { body } : {}) });
    const values = async (doc: string) =>
      (await call('GET', `/documents/${doc}/field-values`)).json.values as Record<string, unknown>;

    async function newTemplate(name = 'Lease') {
      const doc = await h.createDocument({ content: templateContent() });
      const made = await call('POST', '/templates', { document: doc, name });
      expect(made.status, made.text).toBe(201);
      return { doc, template: made.json.id as string, ref: { tenant: h.tenant, doc } };
    }
    const instantiate = (template: string, extra: Record<string, unknown> = {}) =>
      call('POST', '/documents', { template, ...extra });

    it.skipIf(skip)(
      'lists, creates and reads templates, with a service credential only (criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: templateContent() });
        const made = await call('POST', '/templates', { document: doc, name: 'Lease A' });
        expect(made.status, made.text).toBe(201);
        expect(made.json).toMatchObject({ document: doc, name: 'Lease A' });
        expect(made.json.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

        const read = await call('GET', `/templates/${made.json.id}`);
        expect(read.status).toBe(200);
        expect(read.json).toEqual(made.json);
        const list = await call('GET', '/templates');
        expect(list.status).toBe(200);
        expect((list.json.items as Array<{ id: string }>).map((t) => t.id)).toContain(made.json.id);

        // A document is the template of one record; an unknown document or template is not found.
        expect((await call('POST', '/templates', { document: doc, name: 'Again' })).status).toBe(
          409,
        );
        const ghost = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c01';
        expect((await call('POST', '/templates', { document: ghost, name: 'x' })).status).toBe(404);
        expect((await call('GET', `/templates/${ghost}`)).status).toBe(404);

        // A user credential is not a service credential.
        const user = h.userToken({ [doc]: 'owner' });
        expect((await call('GET', '/templates', undefined, user)).status).toBe(403);
        expect((await call('POST', '/templates', { document: doc, name: 'u' }, user)).status).toBe(
          403,
        );
        expect((await call('GET', `/templates/${made.json.id}`, undefined, user)).status).toBe(403);
      },
      60_000,
    );

    it.skipIf(skip)(
      'forks the template at a pinned seq, binds participants to the roles and prefills values in one call (criteria 1 and 2)',
      async () => {
        const { doc, template, ref } = await newTemplate();
        const head = (await h.parts.logs.head(ref)).seq;

        const made = await instantiate(template, {
          title: 'Case 1',
          participants: [person('p1', 'tenant', 1), person('p2', 'landlord', 2)],
          values: { 'tenant.name': 'Ada', 'lease.total': '1200' },
        });
        expect(made.status, made.text).toBe(201);
        expect(made.json.template).toEqual({ id: template, seq: head });
        expect(made.json.title).toBe('Case 1');
        const copy = made.json.id as string;
        expect(copy).not.toBe(doc);

        // The pinned seq is recorded on the new document, as a fork's is.
        const record = await h.parts.documents.get({ tenant: h.tenant, doc: copy });
        expect([record?.forkedFrom, record?.forkedAtSeq]).toEqual([doc, head]);

        // Participants are bound to the roles, as the draft workflow of the copy.
        const wf = await call('GET', `/documents/${copy}/workflow`);
        expect(wf.status, wf.text).toBe(200);
        expect(wf.json.state).toBe('draft');
        expect(
          (wf.json.participants as Array<{ id: string; roles: string[]; sub: string }>).map((p) => [
            p.id,
            p.roles,
            p.sub,
          ]),
        ).toEqual([
          ['p1', ['tenant'], 'sub-p1'],
          ['p2', ['landlord'], 'sub-p2'],
        ]);
        // The values are in place when the call answers, and the template has none.
        expect(await values(copy)).toMatchObject({ 'tenant.name': 'Ada', 'lease.total': '1200' });
        expect(await values(doc)).toMatchObject({ 'tenant.name': null, 'lease.total': null });
      },
      60_000,
    );

    it.skipIf(skip)(
      'pins the seq asked for, and a later change of the template leaves existing instances alone (criterion 3)',
      async () => {
        const { doc, template, ref } = await newTemplate();
        const first = await instantiate(template, { values: { 'tenant.name': 'Before' } });
        expect(first.status, first.text).toBe(201);
        const before = (await h.parts.logs.head(ref)).seq;

        // The template changes: a prefill on the template document (a new commit).
        const patch = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service(),
          body: { values: { 'tenant.name': 'Changed template' } },
          headers: {
            'if-match': (await call('GET', `/documents/${doc}/field-values`)).headers.get('etag')!,
          },
        });
        expect(patch.status, patch.text).toBe(200);
        const after = (await h.parts.logs.head(ref)).seq;
        expect(after).toBeGreaterThan(before);

        // The instance made before is unchanged, and has no commit of the template's.
        expect((await values(first.json.id))['tenant.name']).toBe('Before');
        expect(
          (await h.parts.logs.head({ tenant: h.tenant, doc: first.json.id })).seq,
        ).toBeGreaterThan(0);
        // The head now: the changed value, recorded at the head. The pinned seq asked for: the old one.
        const latest = await instantiate(template);
        expect(latest.json.template).toEqual({ id: template, seq: after });
        expect((await values(latest.json.id))['tenant.name']).toBe('Changed template');
        const pinned = await instantiate(template, { templateSeq: before });
        expect(pinned.status, pinned.text).toBe(201);
        expect(pinned.json.template).toEqual({ id: template, seq: before });
        expect((await values(pinned.json.id))['tenant.name']).toBeNull();
        // A seq the template has not reached is not found.
        expect((await instantiate(template, { templateSeq: after + 50 })).status).toBe(404);
      },
      90_000,
    );

    it.skipIf(skip)(
      'starts as a draft with no workflow, no lock and no grants when the template carries a workflow in another state (criterion 4)',
      async () => {
        const { doc, template, ref } = await newTemplate();
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-062-${doc}` });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: {
            id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cd3',
            doc,
            state: 'draft',
            rev: 0,
            timeZone: 'UTC',
            participants: [person('t1', 'tenant', 1), person('t2', 'landlord', 2)],
          },
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(sent.status, sent.text).toBe(200);
        expect((await h.parts.grants.current(ref)).workflowActive).toBe(true);

        const copy = await instantiate(template);
        expect(copy.status, copy.text).toBe(201);
        const id = copy.json.id as string;
        // No workflow came along (it is not a copy of the template's), and the document is not locked.
        expect((await call('GET', `/documents/${id}/workflow`)).status).toBe(404);
        const perms = await h.parts.grants.current({ tenant: h.tenant, doc: id });
        expect(perms.workflowActive).toBe(false);
        expect(perms.documentState).toBe('active');
        expect(copy.json.state).toBe('active');
        expect(perms.grants).toEqual([]);
        // It can be given a workflow of its own, which starts as a draft.
        const ownerOfCopy = h.userToken({ [id]: 'owner' }, { sub: `owner-062-${id}` });
        const own = await h.call('PUT', `/v1/documents/${id}/workflow`, {
          token: ownerOfCopy,
          body: {
            id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cd4',
            doc: id,
            state: 'draft',
            rev: 0,
            timeZone: 'UTC',
            participants: [person('n1', 'tenant', 1)],
          },
          headers: { 'if-match': '"0"' },
        });
        expect(own.status, own.text).toBe(201);
        expect(own.json.state).toBe('draft');
      },
      90_000,
    );

    it.skipIf(skip)(
      'refuses a call as a whole and creates no document when a template, a role, a key or a value is wrong',
      async () => {
        const { template } = await newTemplate();
        const count = async () =>
          ((await call('GET', '/documents?limit=200')).json.items as unknown[]).length;
        const before = await count();

        const ghost = await instantiate('0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c02');
        expect(ghost.status).toBe(404);
        const badRole = await instantiate(template, {
          participants: [person('p1', 'witness', 1)],
        });
        expect(badRole.status, badRole.text).toBe(400);
        expect(badRole.json.violations).toEqual([
          { path: '/participants/0/roles', rule: expect.stringContaining('witness') },
        ]);
        const badShape = await instantiate(template, {
          participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler' }],
        });
        expect(badShape.status).toBe(400);
        const badKey = await instantiate(template, {
          participants: [person('p1', 'tenant', 1)],
          values: { 'tenant.name': 'Ada', 'no.such.key': 'x' },
        });
        expect(badKey.status, badKey.text).toBe(422);
        expect(badKey.json.violations).toEqual([
          { path: '/values/no.such.key', rule: expect.stringContaining('field') },
        ]);
        const badValue = await instantiate(template, { values: { 'lease.total': 'not a number' } });
        expect(badValue.status, badValue.text).toBe(422);
        expect(await count()).toBe(before);
      },
      60_000,
    );

    it.skipIf(skip)(
      'needs a service credential (criterion 6)',
      async () => {
        const { doc, template } = await newTemplate();
        const user = h.userToken({ [doc]: 'owner' });
        const r = await call('POST', '/documents', { template }, user);
        expect(r.status).toBe(403);
      },
      60_000,
    );
  });
}
