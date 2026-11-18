// FRW-029 over the service (lane w4): once `POST /documents/{id}/workflow/send` has locked a
// document, the real data plane refuses an owner's commit with `read_only` and the REST surface
// refuses a whole-document restore and a content replacement with `workflow_active`; nothing is
// stored by any of them. On memory storage and, when the test environment is up, on PostgreSQL in
// Podman (infra/test-env.ps1). The room-level rules (every user and every kind of change) are
// tested in packages/authority/test/frw-029.lock-commits.test.ts.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient, insertText } from '../data-plane/client.ts';
import { posInside, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** The regions fixture with a role, a required field the role fills, and nothing to resolve. */
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
    attrs: { id: 'pFields000000003' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'ff00000000000001',
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

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9e',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1 }],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a document locked by a running workflow (${storage}; FRW-029)`, async () => {
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

    /** A sent document with its owner connected: the lock is the one the send route sets. */
    async function sent() {
      const content = document();
      const doc = await h.createDocument({ content });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-029-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const client = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(client);
      expect((await client.hello(owner)).t).toBe('welcome');
      expect((await client.open(1, doc)).t).toBe('ch.opened');
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(r.status, r.text).toBe(200);
      const ref = { tenant: h.tenant, doc };
      const pos = posInside(
        schema.nodeFromJSON((content as { doc: unknown }).doc),
        'pIntro0000000001',
      );
      return { doc, owner, ref, client, pos, head: (await h.parts.logs.head(ref)).seq };
    }

    it.skipIf(skip)(
      'refuses an owner’s text commit over the wire with read_only, and stores nothing (criterion 1)',
      async () => {
        const { ref, client, pos, head } = await sent();
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('locked');
        expect(perms.workflowActive).toBe(true);
        const answer = await client.submit(1, { base: head, steps: [insertText(pos, 'x')] });
        expect(answer.t).toBe('sync.reject');
        expect(answer.d).toMatchObject({ code: 'read_only', action: 'drop' });
        expect((await h.parts.logs.head(ref)).seq).toBe(head);
      },
    );

    it.skipIf(skip)(
      'refuses a whole-document restore with workflow_active, and the content and the versions stay (criterion 4)',
      async () => {
        const { doc, owner, ref, head } = await sent();
        const versions = (await h.parts.versions!.list(ref, {})).length;
        const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: owner,
          body: { toSeq: 0 },
        });
        expect(r.status, r.text).toBe(409);
        expect(r.json.code).toBe('workflow_active');
        expect((await h.parts.logs.head(ref)).seq).toBe(head);
        expect((await h.parts.versions!.list(ref, {})).length).toBe(versions);
      },
    );

    it.skipIf(skip)('refuses a replacement of the content with workflow_active', async () => {
      const { doc, ref, head } = await sent();
      const read = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const r = await h.call('PUT', `/v1/documents/${doc}/content`, {
        token: h.apiKey,
        body: document(),
        headers: { 'If-Match': read.headers.get('etag')! },
      });
      expect(r.status, r.text).toBe(409);
      expect(r.json.code).toBe('workflow_active');
      expect((await h.parts.logs.head(ref)).seq).toBe(head);
    });
  });
}
