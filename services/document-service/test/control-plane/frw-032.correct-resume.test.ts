// FRW-032 through the real service: `POST /documents/{id}/workflow/correct` and `/resume` against the
// real data plane with an owner connected, on memory storage and, when the test environment is up, on
// PostgreSQL in Podman. The workflow is sent by the send route and progressed with `recordFirstView`
// and `recordCompletion` (FRW-031; the participant routes are FRW-047). The owner then corrects the
// document over the wire, as an editor of a draft would, and resumes. docs/adr/0385-w4-FRW-032-correct-and-resume.md
// (proposed).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient, insertText as insertAt } from '../data-plane/client.ts';
import { posInside, posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
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

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9f',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1 },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 1 },
    { id: 'p3', roles: ['witness'], kind: 'signer', order: 2 },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`correct and resume (${storage}; FRW-032)`, async () => {
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

    /**
     * A workflow in progress with p1 and p2 (order 1) completed, p3 (order 2) active, and an owner on
     * its channel: sent by the route, opened by p1's first view, completed by p1 and p2.
     */
    async function running() {
      const content = document();
      const doc = await h.createDocument({ content });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-032-${uuid7()}` });
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
      const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(sent.status, sent.text).toBe(200);
      const ref = { tenant: h.tenant, doc };
      expect(await recordFirstView(deps(), { ref, actor: 'p1', participant: 'p1' })).toMatchObject({
        ok: true,
      });
      for (const pid of ['p1', 'p2'])
        expect(await recordCompletion(deps(), { ref, actor: pid, participant: pid })).toMatchObject(
          { ok: true },
        );
      const tree = schema.nodeFromJSON((content as { doc: unknown }).doc);
      return {
        doc,
        owner,
        ref,
        client,
        sentSeq: sent.json.sentSeq as number,
        intro: posInside(tree, 'pIntro0000000001'),
        tenantField: posOf(tree, TENANT_FIELD),
      };
    }

    const post = (doc: string, token: string, action: 'correct' | 'resume', key?: string) =>
      h.call('POST', `/v1/documents/${doc}/workflow/${action}`, {
        token,
        ...(key ? { headers: { 'idempotency-key': key } } : {}),
      });
    const marks = async (ref: { tenant: string; doc: string }) =>
      Object.fromEntries(
        (await h.parts.workflows!.read(ref.tenant, ref.doc))!.participants.map((p) => [
          p.id,
          p.state,
        ]),
      );
    const controls = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control').length;
    const insertText = (pos: number) => insertAt(pos, 'x');
    const setValue = (pos: number, value: string) => ({
      stepType: 'attr',
      pos,
      attr: 'value',
      value,
    });

    it.skipIf(skip)(
      'refuses a caller without manage as forbidden, and a state that does not fit as conflict (criterion 7)',
      async () => {
        const { doc, owner, ref } = await running();
        const editor = h.userToken({ [doc]: 'editor' }, { sub: `editor-032-${uuid7()}` });
        for (const action of ['correct', 'resume'] as const) {
          const r = await post(doc, editor, action);
          expect(r.status, `${action} ${r.text}`).toBe(403);
          expect(r.json.code).toBe('forbidden');
        }
        expect((await h.parts.workflows!.read(ref.tenant, doc))!.state).toBe('in_progress');
        // Resume of a workflow that is not being corrected.
        const early = await post(doc, owner, 'resume');
        expect(early.status, early.text).toBe(409);
        expect(early.json.code).toBe('conflict');
      },
    );

    it.skipIf(skip)(
      'corrects: pauses the participants, unlocks the document, writes a control commit and raises corrected (criteria 1 and 3)',
      async () => {
        const { doc, owner, ref, client, intro, tenantField } = await running();
        const before = await controls(ref);
        const key = `correct-${uuid7()}`;
        const r = await post(doc, owner, 'correct', key);
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('correcting');
        // Everyone who has not completed is paused; a completed participant keeps the mark.
        expect(await marks(ref)).toEqual({ p1: 'completed', p2: 'completed', p3: 'paused' });
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('active');
        expect(perms.workflowActive).toBe(false);
        // One control commit for the transition, and the event.
        expect(await controls(ref)).toBe(before + 1);
        const events = h.events.of('dep.workflow.corrected.v1').filter((e) => e.subject === doc);
        expect(events).toHaveLength(1);
        expect(events[0]!.data['document']).toBe(doc);

        // The same request again with the same key is answered from the stored response.
        const again = await post(doc, owner, 'correct', key);
        expect(again.status).toBe(200);
        expect(again.json).toEqual(r.json);
        expect(
          h.events.of('dep.workflow.corrected.v1').filter((e) => e.subject === doc),
        ).toHaveLength(1);

        // Criterion 3: the owner changes the body and a field, and both are stored.
        const head = (await h.parts.logs.head(ref)).seq;
        const text = await client.submit(1, { base: head, steps: [insertText(intro)] });
        expect(text.t, JSON.stringify(text)).toBe('sync.ack');
        const value = await client.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [setValue(tenantField, 'Cy')],
        });
        expect(value.t, JSON.stringify(value)).toBe('sync.ack');

        // A second correction of the same workflow is a conflict.
        const second = await post(doc, owner, 'correct', `correct-${uuid7()}`);
        expect(second.status, second.text).toBe(409);
      },
    );

    it.skipIf(skip)(
      'resumes with nothing changed: nobody is reset and the document is locked again (criterion 5)',
      async () => {
        const { doc, owner, ref } = await running();
        expect((await post(doc, owner, 'correct')).status).toBe(200);
        const before = await controls(ref);
        const r = await post(doc, owner, 'resume', `resume-${uuid7()}`);
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('in_progress');
        expect(await marks(ref)).toEqual({ p1: 'completed', p2: 'completed', p3: 'active' });
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('locked');
        expect(perms.workflowActive).toBe(true);
        expect(await controls(ref)).toBe(before + 1);
        // The participants who are active again are told, once each.
        const activated = h.events
          .of('dep.workflow.participant_activated.v1')
          .filter((e) => e.subject === doc)
          .map((e) => e.data['participant']);
        // The send raised p1 and p2; the completions above were recorded without their route, so the
        // only other one is the resume's: p3, who is active again.
        expect(activated).toEqual(['p1', 'p2', 'p3']);
        // sentSeq stays the send's (ADR 0385, point 6).
        expect((await h.parts.workflows!.read(ref.tenant, doc))!.sentSeq).toBe(
          (r.json as { sentSeq: number }).sentSeq,
        );
      },
    );

    it.skipIf(skip)(
      'resumes after a change of one participant’s field: only that participant must complete again (criterion 4)',
      async () => {
        const { doc, owner, ref, client, tenantField } = await running();
        expect((await post(doc, owner, 'correct')).status).toBe(200);
        const fix = await client.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [setValue(tenantField, 'Cy')],
        });
        expect(fix.t, JSON.stringify(fix)).toBe('sync.ack');
        const r = await post(doc, owner, 'resume');
        expect(r.status, r.text).toBe(200);
        // p1 (the tenant) is reset and is active again; p2 (the landlord) keeps its completion; p3 waits
        // for the order 1 participant who is not done.
        expect(await marks(ref)).toEqual({ p1: 'active', p2: 'completed', p3: 'pending' });
        const stored = (await h.parts.workflows!.read(ref.tenant, doc))!;
        expect(stored.participants.find((p) => p.id === 'p1')!.completedSeq).toBeUndefined();
      },
    );

    it.skipIf(skip)(
      'resumes after a change of the body: every completed participant must complete again (criteria 4 and 6)',
      async () => {
        const { doc, owner, ref, client, intro } = await running();
        expect((await post(doc, owner, 'correct')).status).toBe(200);
        const edit = await client.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [insertText(intro)],
        });
        expect(edit.t, JSON.stringify(edit)).toBe('sync.ack');
        const r = await post(doc, owner, 'resume');
        expect(r.status, r.text).toBe(200);
        expect(await marks(ref)).toEqual({ p1: 'active', p2: 'active', p3: 'pending' });
        // The body is locked again: the owner's next change is refused.
        const late = await client.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [insertText(intro)],
        });
        expect(late.t).toBe('sync.reject');
        expect(late.d).toMatchObject({ code: 'read_only' });
      },
    );
  });
}
