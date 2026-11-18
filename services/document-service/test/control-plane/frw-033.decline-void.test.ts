// FRW-033 through the real service: `POST /documents/{id}/workflow/void` and
// `POST /documents/{id}/workflow/participants/{pid}/decline` against the real data plane with an owner
// and a participant connected, on memory storage and, when the test environment is up, on PostgreSQL
// in Podman. The workflow is sent by the send route and opened by the first view (`recordFirstView`,
// FRW-031). docs/adr/0386-w4-FRW-033-decline-and-void.md (proposed).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient, insertText } from '../data-plane/client.ts';
import { posInside, posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import { recordFirstView } from '../../src/workflow/progress.ts';
import type { TransitionDeps } from '../../src/workflow/transitions.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TENANT_FIELD = 'ffTenant00000001';

/** The regions fixture with two roles, and a field the tenant fills. */
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
          id: TENANT_FIELD,
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
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
    { id: 'p3', roles: ['landlord'], kind: 'cc', order: 3, sub: 'sub-p3' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`decline and void (${storage}; FRW-033)`, async () => {
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

    /** A document with its workflow in `draft` (or sent, or in progress) and an owner connected. */
    async function workflow(until: 'draft' | 'sent' | 'in_progress') {
      const content = document();
      const doc = await h.createDocument({ content });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-033-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const ownerClient = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(ownerClient);
      expect((await ownerClient.hello(owner)).t).toBe('welcome');
      expect((await ownerClient.open(1, doc)).t).toBe('ch.opened');
      const ref = { tenant: h.tenant, doc };
      if (until !== 'draft') {
        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(sent.status, sent.text).toBe(200);
      }
      if (until === 'in_progress')
        expect(
          await recordFirstView(deps(), { ref, actor: 'p1', participant: 'p1' }),
        ).toMatchObject({ ok: true });
      const tree = schema.nodeFromJSON((content as { doc: unknown }).doc);
      return {
        doc,
        owner,
        ref,
        ownerClient,
        tenantField: posOf(tree, TENANT_FIELD),
      };
    }

    const participantToken = (doc: string, pid: string, claims: Record<string, unknown> = {}) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid, wfr: ['tenant'], ...claims });
    const post = (path: string, token: string, body: unknown, key?: string) =>
      h.call('POST', path, {
        token,
        body,
        ...(key ? { headers: { 'idempotency-key': key } } : {}),
      });
    const state = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.workflows!.read(ref.tenant, ref.doc))!;
    const controls = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control').length;
    const setValue = (pos: number, value: string) => ({
      stepType: 'attr',
      pos,
      attr: 'value',
      value,
    });
    const reasonOf = async (doc: string, kind: string) =>
      (await h.parts.audit!.query(h.tenant, { doc, kind, limit: 100 })).map((e) => e.data);

    it.skipIf(skip)(
      'refuses a void without manage as forbidden, a draft as conflict, and a missing or blank reason as validation_failed, changing nothing (criteria 3 and 6)',
      async () => {
        const draft = await workflow('draft');
        const w = `/v1/documents/${draft.doc}/workflow/void`;
        // A draft is not voided.
        const early = await post(w, draft.owner, { reason: 'Stop' });
        expect(early.status, early.text).toBe(409);
        expect((await state(draft.ref)).state).toBe('draft');

        const running = await workflow('sent');
        const path = `/v1/documents/${running.doc}/workflow/void`;
        const editor = h.userToken({ [running.doc]: 'editor' }, { sub: `ed-033-${uuid7()}` });
        const refused = await post(path, editor, { reason: 'Stop' });
        expect(refused.status, refused.text).toBe(403);
        expect(refused.json.code).toBe('forbidden');
        const before = await controls(running.ref);
        for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }]) {
          const r = await post(path, running.owner, body);
          expect(r.status, `${JSON.stringify(body)} ${r.text}`).toBe(400);
          expect(r.json.code).toBe('validation_failed');
        }
        // The blank reason is the authority's refusal, with the pointer to the member.
        const blank = await post(path, running.owner, { reason: '   ' });
        expect(blank.json.violations).toEqual([{ path: '/reason', rule: 'a reason is required' }]);
        expect((await state(running.ref)).state).toBe('sent');
        expect(await controls(running.ref)).toBe(before);
        expect(
          h.events.of('dep.workflow.voided.v1').filter((e) => e.subject === running.doc),
        ).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'voids a sent workflow: the state, the lock, the control commit, the event and the audit entry, once (criteria 2 and 4)',
      async () => {
        const { doc, owner, ref } = await workflow('sent');
        // A participant with a fill role fills while the workflow runs.
        const filler = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(filler);
        const token = participantToken(doc, 'p1');
        expect((await filler.hello(token)).t).toBe('welcome');
        expect((await filler.open(1, doc)).t).toBe('ch.opened');
        const tree = schema.nodeFromJSON((document() as { doc: unknown }).doc);
        const field = posOf(tree, TENANT_FIELD);
        // The first view moved the workflow to `in_progress`, with a control commit of its own
        // (FRW-030 criterion 1): wait until it is written, so that `before` counts the void alone.
        let before = await controls(ref);
        for (let stable = 0; stable < 4;) {
          await new Promise((r) => setTimeout(r, 50));
          const now = await controls(ref);
          stable = now === before ? stable + 1 : 0;
          before = now;
        }
        const filled = await filler.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [setValue(field, 'Ada')],
        });
        expect(filled.t, JSON.stringify(filled)).toBe('sync.ack');

        const key = `void-${uuid7()}`;
        const r = await post(
          `/v1/documents/${doc}/workflow/void`,
          owner,
          { reason: ' Wrong tenant ' },
          key,
        );
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('voided');
        const stored = await state(ref);
        expect(stored.participants.map((p) => [p.id, p.state])).toEqual([
          ['p1', 'closed'],
          ['p2', 'closed'],
          ['p3', 'closed'],
        ]);
        // The document stays locked, and no workflow runs (criterion 4).
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('locked');
        expect(perms.workflowActive).toBe(false);
        expect(await controls(ref)).toBe(before + 1);
        // `voided` is raised once; a repeated key adds nothing.
        const again = await post(
          `/v1/documents/${doc}/workflow/void`,
          owner,
          { reason: ' Wrong tenant ' },
          key,
        );
        expect(again.status).toBe(200);
        expect(again.json).toEqual(r.json);
        expect(h.events.of('dep.workflow.voided.v1').filter((e) => e.subject === doc)).toHaveLength(
          1,
        );
        // The reason (trimmed) is in the audit entry of the transition, with who stopped it.
        const audits = await reasonOf(doc, 'workflow.transition');
        expect(audits.at(-1)).toMatchObject({
          // The participant who filled opened the document, which moved the workflow on (FRW-040).
          from: 'in_progress',
          to: 'voided',
          reason: 'Wrong tenant',
          by: null,
        });
        // And not in the webhook (FRW-036).
        const event = h.events.of('dep.workflow.voided.v1').find((e) => e.subject === doc)!;
        expect(JSON.stringify(event)).not.toContain('Wrong tenant');
        expect(event.data).not.toHaveProperty('participant');

        // The participant's token no longer allows filling.
        const refused = await filler.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [setValue(field, 'Bea')],
        });
        expect(refused.t).toBe('sync.reject');
        expect(refused.d).toMatchObject({ code: 'read_only' });
      },
    );

    it.skipIf(skip)(
      'allows no further transition once voided: send, correct, resume, void and decline are conflicts, and nothing changes (criterion 4)',
      async () => {
        const { doc, owner, ref } = await workflow('in_progress');
        const v = await post(`/v1/documents/${doc}/workflow/void`, owner, { reason: 'Stop' });
        expect(v.status, v.text).toBe(200);
        const rev = (await state(ref)).rev;
        const controlsBefore = await controls(ref);
        for (const [path, token, body] of [
          ['send', owner, undefined],
          ['correct', owner, undefined],
          ['resume', owner, undefined],
          ['void', owner, { reason: 'Again' }],
          ['participants/p1/decline', participantToken(doc, 'p1'), { reason: 'No' }],
        ] as const) {
          const r = await post(`/v1/documents/${doc}/workflow/${path}`, token, body);
          expect(r.status, `${path} ${r.text}`).toBe(409);
          expect(r.json.code).toBe('conflict');
        }
        expect((await state(ref)).rev).toBe(rev);
        expect(await controls(ref)).toBe(controlsBefore);
        expect((await state(ref)).state).toBe('voided');
      },
    );

    it.skipIf(skip)(
      'lets a participant decline with a reason: the state, the event, the audit entry and the lock (criterion 1, in part)',
      async () => {
        const { doc, ref, owner } = await workflow('in_progress');
        const before = await controls(ref);
        const token = participantToken(doc, 'p1');
        const path = `/v1/documents/${doc}/workflow/participants/p1/decline`;
        // A blank reason changes nothing.
        for (const body of [{}, { reason: '  ' }]) {
          const bad = await post(path, token, body);
          expect(bad.status, bad.text).toBe(400);
          expect(bad.json.code).toBe('validation_failed');
        }
        expect((await state(ref)).state).toBe('in_progress');
        expect(await controls(ref)).toBe(before);

        const r = await post(path, token, { reason: 'I do not agree to clause 4' });
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('declined');
        expect(await controls(ref)).toBe(before + 1);
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('locked');
        expect(perms.workflowActive).toBe(false);
        const events = h.events
          .of('dep.workflow.participant_declined.v1')
          .filter((e) => e.subject === doc);
        expect(events).toHaveLength(1);
        expect(events[0]!.data['participant']).toBe('p1');
        expect(JSON.stringify(events[0])).not.toContain('clause');
        const audits = await reasonOf(doc, 'workflow.transition');
        expect(audits.at(-1)).toMatchObject({
          from: 'in_progress',
          to: 'declined',
          by: 'p1',
          reason: 'I do not agree to clause 4',
        });
        // The owner cannot resume what was declined, and a void is refused too.
        expect(
          (await post(`/v1/documents/${doc}/workflow/void`, owner, { reason: 'x' })).status,
        ).toBe(409);
        expect((await post(`/v1/documents/${doc}/workflow/correct`, owner, undefined)).status).toBe(
          409,
        );
      },
    );

    it.skipIf(skip)(
      'lets the host decline for a participant with its service credential, as for any route (criterion 1)',
      async () => {
        const { doc, ref } = await workflow('in_progress');
        const r = await post(`/v1/documents/${doc}/workflow/participants/p2/decline`, h.apiKey, {
          reason: 'Withdrawn by the host',
        });
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('declined');
        expect((await state(ref)).state).toBe('declined');
        const events = h.events
          .of('dep.workflow.participant_declined.v1')
          .filter((e) => e.subject === doc);
        expect(events.map((e) => e.data['participant'])).toEqual(['p2']);
      },
    );

    it.skipIf(skip)(
      'refuses a decline from anyone but the bound participant, from a cc, and outside in_progress (criterion 1)',
      async () => {
        const { doc, ref, owner } = await workflow('in_progress');
        const path = (pid: string) => `/v1/documents/${doc}/workflow/participants/${pid}/decline`;
        const body = { reason: 'No' };
        // Another participant's token, a token without wfp, a wrong sub, the owner.
        for (const [what, token] of [
          ['another participant', participantToken(doc, 'p2')],
          ['no wfp', h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1' })],
          ['a wrong sub', participantToken(doc, 'p1', { sub: 'sub-someone-else' })],
          ['the owner', owner],
        ] as const) {
          const r = await post(path('p1'), token, body);
          expect(r.status, `${what} ${r.text}`).toBe(403);
          expect(r.json.code).toBe('forbidden');
        }
        // The host's service credential declines for a participant it names; a cc is still refused.
        const hostCc = await post(path('p3'), h.apiKey, body);
        expect(hostCc.status, hostCc.text).toBe(403);
        // A cc participant cannot decline.
        const cc = await post(path('p3'), participantToken(doc, 'p3'), body);
        expect(cc.status, cc.text).toBe(403);
        expect((await state(ref)).state).toBe('in_progress');

        // A sent workflow that nobody has opened is not declined (in_progress only).
        const sent = await workflow('sent');
        const early = await post(
          `/v1/documents/${sent.doc}/workflow/participants/p1/decline`,
          participantToken(sent.doc, 'p1'),
          body,
        );
        expect(early.status, early.text).toBe(409);
        expect((await state(sent.ref)).state).toBe('sent');
      },
    );

    for (const how of ['void', 'decline'] as const) {
      it.skipIf(skip)(
        `leaves a ${how === 'void' ? 'voided' : 'declined'} document locked and reusable only by a fork (criterion 5, the service; FRW-029 criterion 5)`,
        async () => {
          const { doc, owner, ref, ownerClient } = await workflow(
            how === 'void' ? 'sent' : 'in_progress',
          );
          const stopped =
            how === 'void'
              ? await post(`/v1/documents/${doc}/workflow/void`, owner, { reason: 'Reuse' })
              : await post(
                  `/v1/documents/${doc}/workflow/participants/p1/decline`,
                  participantToken(doc, 'p1'),
                  { reason: 'Reuse' },
                );
          expect(stopped.status, stopped.text).toBe(200);
          expect((await h.parts.grants.current(ref)).documentState).toBe('locked');
          const head = (await h.parts.logs.head(ref)).seq;
          const tree = schema.nodeFromJSON((document() as { doc: unknown }).doc);

          // The owner changes nothing over the wire, restores nothing and replaces nothing.
          const edit = await ownerClient.submit(1, {
            base: head,
            steps: [insertText(posInside(tree, 'pIntro0000000001'), 'x')],
          });
          expect(edit.t).toBe('sync.reject');
          expect(edit.d).toMatchObject({ code: 'read_only' });
          const restore = await h.call('POST', `/v1/documents/${doc}/restore`, {
            token: owner,
            body: { toSeq: 0 },
          });
          expect(restore.status, restore.text).toBe(409);
          const etag = (
            await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
          ).headers.get('etag')!;
          const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
            token: h.apiKey,
            body: document(),
            headers: { 'If-Match': etag },
          });
          expect(put.status, put.text).toBe(409);
          expect((await h.parts.logs.head(ref)).seq).toBe(head);

          // The host forks it with its service credential: the copy is a draft with no workflow.
          const forked = await h.call('POST', `/v1/documents/${doc}/fork`, {
            token: h.apiKey,
            body: { atSeq: head },
          });
          expect(forked.status, forked.text).toBe(201);
          const copy = forked.json.id as string;
          expect(copy).not.toBe(doc);
          expect(
            (await h.call('GET', `/v1/documents/${copy}/workflow`, { token: h.apiKey })).status,
          ).toBe(404);
          expect(
            (await h.parts.grants.current({ tenant: h.tenant, doc: copy })).documentState,
          ).toBe('active');
          // A user may not fork: it is the host's operation.
          const user = await h.call('POST', `/v1/documents/${doc}/fork`, {
            token: owner,
            body: { atSeq: head },
          });
          expect(user.status).toBe(403);
        },
      );
    }
  });
}
