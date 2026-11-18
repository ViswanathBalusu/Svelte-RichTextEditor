// FRW-021 through the real service (criteria 3 to 5): the roles of `defs` are part of the document at
// `sentSeq` and frozen by the send, the routing, the participants and the deadlines are in the
// workflow resource and not in the document, and an owner may change a role while the workflow is
// `correcting`, which `resume` counts as a change of the body. Memory storage and, when the test
// environment is up, PostgreSQL in Podman. The real data plane applies the owner's commits.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import { recordCompletion, recordFirstView } from '../../src/workflow/progress.ts';
import type { TransitionDeps } from '../../src/workflow/transitions.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TENANT_FIELD = 'ffTenant00000001';
const LANDLORD_FIELD = 'ffLandlord000001';
const DEADLINE = '2031-03-04T05:06:07.000Z';

/** The regions fixture with three roles and a field for the tenant and one for the landlord. */
function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  for (const [id, name, color] of [
    ['tenant', 'Tenant', '#1F77B4'],
    ['landlord', 'Landlord', '#FF7F0E'],
    ['witness', 'Witness', '#2CA02C'],
  ] as const)
    defs.push({ type: 'role_def', attrs: { id, name, color } });
  const field = (id: string, key: string, assignee: string, value: string) => ({
    type: 'form_field',
    attrs: { id, key, kind: 'text', label: key, assignee, required: true, value },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000003' },
    content: [
      field(TENANT_FIELD, 'tenant.name', 'tenant', 'Ann'),
      { type: 'text', text: ' ' },
      field(LANDLORD_FIELD, 'landlord.name', 'landlord', 'Bo'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

/** Participants with an identifier, a `sub` and a name that no document text contains. */
const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  deadline: DEADLINE,
  reminders: { firstAfterDays: 3, everyDays: 2 },
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-021-ada', name: 'Qux Ada' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 1 },
    { id: 'p3', roles: ['witness'], kind: 'signer', order: 2 },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`rules and roles frozen at send (${storage}; FRW-021)`, async () => {
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

    const deps = (): TransitionDeps => ({
      workflows: h.parts.workflows!,
      grants: h.parts.grants,
      logs: h.parts.logs,
      notifier: h.service.dataPlane,
      audit: h.parts.audit,
      now: h.now,
      controlWaitMs: 5000,
    });
    const renameRole = (pos: number, name: string) => ({
      stepType: 'attr',
      pos,
      attr: 'name',
      value: name,
    });
    /** The `name` of each `role_def` of the document at a sequence number. */
    async function rolesAt(ref: { tenant: string; doc: string }, seq: number) {
      const head = await h.parts.logs.head(ref);
      const full = await h.service.content.rebuild(ref, head.incarnation, seq);
      const found: Record<string, string> = {};
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n !== 'object' || n === null) return;
        const o = n as { type?: string; attrs?: Record<string, string>; content?: unknown };
        if (o.type === 'role_def') found[o.attrs!['id']!] = o.attrs!['name']!;
        walk(o.content);
      };
      walk(full.doc);
      return { roles: found, text: JSON.stringify(full) };
    }

    /** A draft workflow, an owner on its channel, and the document's positions. */
    async function draft() {
      const content = document();
      const doc = await h.createDocument({ content });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-021-${uuid7()}` });
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
      const tree = schema.nodeFromJSON((content as { doc: unknown }).doc);
      return {
        doc,
        owner,
        client,
        ref: { tenant: h.tenant, doc },
        witness: posOf(tree, 'witness'),
      };
    }
    const post = (doc: string, token: string, action: 'send' | 'correct' | 'resume') =>
      h.call('POST', `/v1/documents/${doc}/workflow/${action}`, { token });

    it.skipIf(skip)(
      'records the chain hash at sentSeq, keeps the roles of that sequence, and refuses a later change to defs (criterion 3)',
      async () => {
        const { doc, owner, client, ref, witness } = await draft();
        // A change of a role in the draft is accepted like any change (criterion 2).
        const edit = await client.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [renameRole(witness, 'Observer')],
        });
        expect(edit.t, JSON.stringify(edit)).toBe('sync.ack');
        const before = await h.parts.logs.head(ref);
        const chain = (await h.parts.logs.state!(ref)).chainHead!;
        expect(chain).toMatch(/^[0-9a-f]{64}$/);

        const sent = await post(doc, owner, 'send');
        expect(sent.status, sent.text).toBe(200);
        // sentSeq is the head before the send, and sentHash is the chain hash at that sequence.
        expect(sent.json.sentSeq).toBe(before.seq);
        expect(sent.json.sentHash).toBe(`sha256:${chain}`);
        // The roles are part of the document at sentSeq.
        expect((await rolesAt(ref, before.seq)).roles).toEqual({
          tenant: 'Tenant',
          landlord: 'Landlord',
          witness: 'Observer',
        });

        // The document is locked: the owner's change to a role is refused and nothing is stored.
        const head = (await h.parts.logs.head(ref)).seq;
        const late = await client.submit(1, { base: head, steps: [renameRole(witness, 'Judge')] });
        expect(late.t).toBe('sync.reject');
        expect(late.d).toMatchObject({ code: 'read_only' });
        expect((await h.parts.logs.head(ref)).seq).toBe(head);
        expect((await rolesAt(ref, head)).roles['witness']).toBe('Observer');
      },
    );

    it.skipIf(skip)(
      'keeps participants, deadline and reminders in the workflow resource and out of the document (criterion 4)',
      async () => {
        const { doc, owner, ref } = await draft();
        const sent = await post(doc, owner, 'send');
        expect(sent.status, sent.text).toBe(200);
        const head = (await h.parts.logs.head(ref)).seq;
        const { text } = await rolesAt(ref, head);
        for (const value of ['sub-021-ada', 'Qux Ada', DEADLINE, 'firstAfterDays', '"p1"', '"p3"'])
          expect(text, value).not.toContain(value);
        // The workflow resource holds them.
        const read = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(read.status, read.text).toBe(200);
        expect(read.json.deadline).toBe(DEADLINE);
        expect(read.json.reminders).toEqual({ firstAfterDays: 3, everyDays: 2 });
        expect((read.json.participants as Array<{ id: string }>).map((p) => p.id)).toEqual([
          'p1',
          'p2',
          'p3',
        ]);
      },
    );

    it.skipIf(skip)(
      'lets the owner change a role while the workflow is correcting, and resume counts it as a change of the body (criterion 5)',
      async () => {
        const { doc, owner, client, ref, witness } = await draft();
        expect((await post(doc, owner, 'send')).status).toBe(200);
        expect(
          await recordFirstView(deps(), { ref, actor: 'p1', participant: 'p1' }),
        ).toMatchObject({ ok: true });
        for (const pid of ['p1', 'p2'])
          expect(
            await recordCompletion(deps(), { ref, actor: pid, participant: pid }),
          ).toMatchObject({ ok: true });
        const sentSeq = (await h.parts.workflows!.read(ref.tenant, doc))!.sentSeq!;

        expect((await post(doc, owner, 'correct')).status).toBe(200);
        const edit = await client.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [renameRole(witness, 'Referee')],
        });
        expect(edit.t, JSON.stringify(edit)).toBe('sync.ack');
        const head = (await h.parts.logs.head(ref)).seq;
        expect((await rolesAt(ref, head)).roles['witness']).toBe('Referee');
        // The document at sentSeq still has the role as sent: that is what resume compares with.
        expect((await rolesAt(ref, sentSeq)).roles['witness']).toBe('Witness');

        const r = await post(doc, owner, 'resume');
        expect(r.status, r.text).toBe(200);
        const marks = Object.fromEntries(
          (await h.parts.workflows!.read(ref.tenant, doc))!.participants.map((p) => [
            p.id,
            p.state,
          ]),
        );
        // A change of a definition is a change of the body: both completed participants start again.
        expect(marks).toEqual({ p1: 'active', p2: 'active', p3: 'pending' });
      },
    );
  });
}
