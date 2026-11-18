// FRW-025: the workflow resource through the HTTP routes `GET` and `PUT /documents/{id}/workflow`
// (criteria 1 to 6), on memory storage and, when the test environment is up, on PostgreSQL in Podman
// (infra/test-env.ps1). The decisions are in docs/adr/0371-w4-FRW-025-workflow-put.md (proposed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTenant } from '../../src/storage/db.ts';
import type { MemoryWorkflowResourceStore } from '../../src/workflow/workflow-resource.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const PARTICIPANTS = [
  { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1, name: 'Jane Doe' },
  {
    id: 'p2',
    roles: ['role_landlord'],
    kind: 'signer',
    order: 2,
    auth: { require: ['access_code'] },
  },
];

/** A body as a client sends it back after a read: server-owned members are echoed. */
const body = (doc: string, extra: Record<string, unknown> = {}) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'Europe/Berlin',
  participants: PARTICIPANTS,
  ...extra,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`workflow resource routes (${storage}; FRW-025)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    /**
     * What `send` (FRW-027, not built) will set: the state, `sentSeq`, `sentHash` and a participant's
     * `state` and `completedSeq`. Written to the store directly: it is the only seam there is.
     */
    async function markSent(doc: string): Promise<void> {
      const done = [{ ...PARTICIPANTS[0], state: 'completed', completedSeq: 655 }, PARTICIPANTS[1]];
      if (h.db)
        await inTenant(h.db.service, h.tenant, (c) =>
          c.query(
            `UPDATE workflow_resource
                SET state = 'in_progress', sent_seq = 640, sent_hash = 'sha256:9c1f',
                    participants = $2::jsonb
              WHERE doc_id = $1`,
            [doc, JSON.stringify(done)],
          ),
        );
      else
        (h.parts.workflows as MemoryWorkflowResourceStore).setForTest(h.tenant, doc, {
          state: 'in_progress',
          sentSeq: 640,
          sentHash: 'sha256:9c1f',
          participants: done as never,
        });
    }
    const put = (doc: string, token: string, ifMatch: string | null, b: unknown) =>
      h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token,
        body: b,
        headers: ifMatch === null ? {} : { 'if-match': ifMatch },
      });

    it.skipIf(skip)(
      'has no workflow until a PUT with the ETag "0" creates it, and returns every member with an ETag (criteria 1, 2)',
      async () => {
        const doc = await h.createDocument();
        const owner = h.userToken({ [doc]: 'owner' });
        const missing = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(missing.status).toBe(404);

        const created = await put(
          doc,
          owner,
          '"0"',
          body(doc, {
            deadline: '2026-10-18T00:00:00.000Z',
            reminders: { firstAfterDays: 3, everyDays: 2 },
            consent: { textId: 'esign-consent', version: 3 },
            finalisation: { seal: 'pades-b-lta', certificate: true },
            routing: [{ when: { '>': [{ field: 'lease.total' }, '50000'] }, then: [] }],
          }),
        );
        expect(created.status, created.text).toBe(201);
        expect(created.headers.get('etag')).toBe('"1"');

        const read = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(read.status).toBe(200);
        expect(read.headers.get('etag')).toBe('"1"');
        expect(read.json).toMatchObject({
          doc,
          state: 'draft',
          rev: 1,
          timeZone: 'Europe/Berlin',
          deadline: '2026-10-18T00:00:00.000Z',
          reminders: { firstAfterDays: 3, everyDays: 2 },
          consent: { textId: 'esign-consent', version: 3 },
          finalisation: { seal: 'pades-b-lta', certificate: true },
          participants: PARTICIPANTS,
        });
        expect(typeof read.json.id).toBe('string');
        expect(read.json.routing).toHaveLength(1);
        // Not sent yet: no sentSeq and no sentHash.
        expect(read.json).not.toHaveProperty('sentSeq');
        expect(read.json).not.toHaveProperty('sentHash');
        // The id is the server's, not the one echoed in the body.
        expect(read.json.id).not.toBe(body(doc).id);

        const again = await h.call('GET', `/v1/documents/${doc}/workflow`, {
          token: owner,
          headers: { 'if-none-match': '"1"' },
        });
        expect(again.status).toBe(304);
      },
    );

    it.skipIf(skip)('refuses a second workflow for the same document (criterion 2)', async () => {
      const doc = await h.createDocument();
      const owner = h.userToken({ [doc]: 'owner' });
      expect((await put(doc, owner, '"0"', body(doc))).status).toBe(201);
      const second = await put(doc, owner, '"0"', body(doc));
      expect(second.status).toBe(412);
      expect(second.json.code).toBe('precondition_failed');
    });

    it.skipIf(skip)(
      'applies a PUT with the current If-Match while the state is draft, and refuses a stale or missing one (criterion 3)',
      async () => {
        const doc = await h.createDocument();
        const owner = h.userToken({ [doc]: 'owner' });
        await put(doc, owner, '"0"', body(doc));
        const next = await put(
          doc,
          owner,
          '"1"',
          body(doc, { participants: [PARTICIPANTS[0]], timeZone: 'UTC' }),
        );
        expect(next.status, next.text).toBe(200);
        expect(next.headers.get('etag')).toBe('"2"');
        expect(next.json.participants).toHaveLength(1);
        const stale = await put(doc, owner, '"1"', body(doc));
        expect(stale.status).toBe(412);
        const none = await put(doc, owner, null, body(doc));
        expect(none.status).toBe(428);
        const read = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(read.json.rev).toBe(2);
      },
    );

    it.skipIf(skip)(
      'refuses a PUT with workflow_active once the state is not draft (criterion 3) [neg:code workflow_active]',
      async () => {
        const doc = await h.createDocument();
        const owner = h.userToken({ [doc]: 'owner' });
        await put(doc, owner, '"0"', body(doc));
        await markSent(doc);
        const refused = await put(doc, owner, '"1"', body(doc));
        expect(refused.status).toBe(409);
        expect(refused.json.code).toBe('workflow_active');
      },
    );

    it.skipIf(skip)(
      'returns sentSeq, sentHash and the state of each participant once they are set (criterion 1)',
      async () => {
        const doc = await h.createDocument();
        const owner = h.userToken({ [doc]: 'owner' });
        await put(doc, owner, '"0"', body(doc));
        await markSent(doc);
        const read = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(read.status).toBe(200);
        expect(read.json).toMatchObject({
          state: 'in_progress',
          sentSeq: 640,
          sentHash: 'sha256:9c1f',
        });
        expect(read.json.participants[0]).toMatchObject({ state: 'completed', completedSeq: 655 });
        expect(read.json.participants[1]).toEqual(PARTICIPANTS[1]);
      },
    );
    it.skipIf(skip)(
      'accepts only the four kinds and refuses any other shape with the path of the member (criterion 4)',
      async () => {
        const doc = await h.createDocument();
        const owner = h.userToken({ [doc]: 'owner' });
        // The published schema refuses an unknown kind and a deadline without milliseconds first.
        const schema = await put(
          doc,
          owner,
          '"0"',
          body(doc, {
            participants: [{ id: 'p1', roles: ['r'], kind: 'witness', order: 1 }],
            deadline: 'tomorrow',
          }),
        );
        expect(schema.status).toBe(400);
        expect(schema.json.violations.map((v: { path: string }) => v.path)).toEqual(
          expect.arrayContaining(['/participants/0/kind', '/deadline']),
        );
        // What the schema allows and the resource does not: a limit below 1, a contact detail.
        const bad = await put(
          doc,
          owner,
          '"0"',
          body(doc, {
            participants: [{ id: 'p1', roles: ['r'], kind: 'signer', order: 1, email: 'a@b.c' }],
            reminders: { everyDays: 0 },
          }),
        );
        expect(bad.status).toBe(400);
        expect(bad.json.violations).toEqual(
          expect.arrayContaining([
            { path: '/participants/0/email', rule: 'unknown_member' },
            { path: '/reminders/everyDays', rule: 'invalid_value' },
          ]),
        );
        for (const [i, kind] of ['filler', 'signer', 'approver', 'cc'].entries()) {
          const ok = await put(
            doc,
            owner,
            `"${i}"`,
            body(doc, { participants: [{ id: 'p1', roles: ['r'], kind, order: 1 }] }),
          );
          expect(ok.status, `: ${ok.text}`).toBeLessThan(300);
        }
      },
    );

    it.skipIf(skip)('refuses a caller without manage (criterion 5)', async () => {
      const doc = await h.createDocument();
      const owner = h.userToken({ [doc]: 'owner' });
      await put(doc, owner, '"0"', body(doc));
      for (const role of ['viewer', 'commenter']) {
        const token = h.userToken({ [doc]: role });
        const refused = await put(doc, token, '"1"', body(doc));
        expect(refused.status, role).toBe(403);
        expect(refused.json.code).toBe('forbidden');
      }
      const unchanged = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
      expect(unchanged.json.rev).toBe(1);
    });

    it.skipIf(skip)('announces the feature workflow in discovery (criterion 6)', async () => {
      const discovery = await h.call('GET', '/.well-known/dep');
      expect(discovery.status).toBe(200);
      expect(discovery.json.features).toContain('workflow');
    });
  });
}
