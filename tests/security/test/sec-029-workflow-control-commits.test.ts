/**
 * SEC-029 criterion 3, workflow half (lane w8): workflow changes appear in the chain as control
 * commits, as permission changes do (08 §2, §12; 07 §9; FRW-030). The permission half is in
 * sec-029-control-commits.test.ts.
 *
 * A workflow is created, sent through the send route and voided through the void route, over the
 * real service with a connected room (the room writes the control commit). Each transition is read
 * back from the log as a control commit with no steps, at the grants revision the transition
 * raised, with a link to the commit before it. On PostgreSQL the chain verifier then accepts the
 * log, so the control commits are inside the chain and not beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../../../services/document-service/test/data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../../services/document-service/test/control-plane/support.ts';
import type { PgLogStore } from '../../../services/document-service/src/storage/log-store.ts';

const TEXT_ID = 'esign-consent';

/** The regions fixture with one role and one field assigned to it, so that a send passes its check. */
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
    attrs: { id: 'pSec029000000001' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'fs02900000000001',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: false,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c29',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  consent: { textId: TEXT_ID, version: 1 },
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-p1' }],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`SEC-029 workflow changes are control commits in the chain (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    }, 60_000);

    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    /** Waits until the log holds `count` control commits, then returns them. */
    async function controls(ref: { tenant: string; doc: string }, count: number) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const rows = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');
        if (rows.length >= count) return rows;
        if (Date.now() > deadline)
          throw new Error(`only ${rows.length} of ${count} control commits were recorded in time`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it.skipIf(skip)(
      'a send and a void each leave a control commit with no steps, in the chain, at their own revision',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const ref = { tenant: h.tenant, doc };
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-sec029-${doc}` });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: body(doc),
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        // The owner's channel opens the room, which writes the control commits.
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        expect((await c.hello(owner)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');

        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(sent.status, sent.text).toBe(200);
        const afterSend = await controls(ref, 1);
        expect(afterSend).toHaveLength(1);
        const sendRevision = (await h.parts.grants.current(ref)).revision;
        expect(afterSend[0]!.revision).toBe(sendRevision);
        expect(afterSend[0]!.steps).toEqual([]);

        const voided = await h.call('POST', `/v1/documents/${doc}/workflow/void`, {
          token: owner,
          body: { reason: 'Wrong tenant' },
          headers: { 'idempotency-key': `void-${doc}` },
        });
        expect(voided.status, voided.text).toBe(200);
        const voidRevision = (await h.parts.grants.current(ref)).revision;
        expect(voidRevision).toBeGreaterThan(sendRevision);
        const all = await controls(ref, 2);
        expect(all.map((x) => x.revision)).toContain(voidRevision);
        expect(all.filter((x) => x.revision === voidRevision)).toHaveLength(1);
        expect(all.every((x) => x.steps.length === 0)).toBe(true);

        // They are rows of the one log, in its order, and the chain over the whole log verifies.
        const rows = await h.parts.logs.read(ref);
        expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
        if (storage === 'postgres') {
          const verdict = await (h.parts.logs as unknown as PgLogStore).verify(ref);
          expect(verdict.ok).toBe(true);
        }
      },
      60_000,
    );
  });
}
