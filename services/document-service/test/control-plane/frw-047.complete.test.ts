// FRW-047 through the real service: a participant completes their part with
// `POST /documents/{id}/workflow/participants/{pid}/complete`. The real data plane applies the
// server-authored commit with origin `rules` (the outbox delivers it to the room); the workflow
// resource, the log, the evidence and the events are read back. Memory storage and, when the test
// environment is up, PostgreSQL in Podman. docs/adr/0398-w4-FRW-047-complete-participant.md (proposed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import {
  skipReason,
  startHarness,
  documentWithRegions,
  type Harness,
  type Storage,
} from './support.ts';

const id = (n: number) => `fc${String(n).padStart(14, '0')}`;
/** `good`: every required field holds a value and every value passes. */
function document(good: boolean): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  defs.push({
    type: 'rule_def',
    attrs: { id: 'ruleHide00000001', when: true, then: [{ hide: ['tenant.secret'] }] },
  });
  defs.push({
    type: 'rule_def',
    attrs: {
      id: 'ruleSum000000001',
      when: true,
      then: [
        {
          set: {
            field: 'tenant.total',
            value: { '*': [{ field: 'tenant.qty' }, { field: 'tenant.price' }] },
          },
        },
      ],
    },
  });
  const ff = (
    n: number,
    key: string,
    kind: string,
    assignee: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'form_field',
    attrs: { id: id(n), key, kind, label: key, assignee, required: false, value: null, ...extra },
  });
  const sp = { type: 'text', text: ' ' };
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pComplete0000001' },
    content: [
      ff(1, 'tenant.name', 'text', 'tenant', { required: true, value: good ? 'Ada' : null }),
      sp,
      ff(2, 'tenant.code', 'text', 'tenant', {
        validation: { pattern: '^[0-9]+$' },
        value: good ? '123' : 'ab',
      }),
      sp,
      ff(3, 'tenant.qty', 'number', 'tenant', { value: '2' }),
      sp,
      ff(4, 'tenant.price', 'number', 'tenant', { value: '3' }),
      sp,
      ff(5, 'tenant.total', 'formula', 'tenant'),
      sp,
      ff(6, 'tenant.secret', 'text', 'tenant', { value: 'hush' }),
      sp,
      ff(7, 'landlord.name', 'text', 'landlord', { required: true, value: 'Bob' }),
      sp,
      ff(8, 'landlord.note', 'text', 'landlord', { value: 'keep' }),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cd1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'filler', order: 2, sub: 'sub-p2' },
    { id: 'ap', roles: ['landlord'], kind: 'approver', order: 3, sub: 'sub-ap' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`completing a participant's part (${storage}; FRW-047)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true, config: { jobIdleMs: 20 } });
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const token = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });

    /** A sent workflow whose first participant has opened the document (the workflow runs). */
    async function running(good: boolean) {
      const doc = await h.createDocument({ content: document(good) });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-047-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(sent.status, sent.text).toBe(200);
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token(doc, 'p1'))).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    const complete = (doc: string, pid: string, payload: unknown = {}) =>
      h.call('POST', `/v1/documents/${doc}/workflow/participants/${pid}/complete`, {
        token: token(doc, pid),
        body: payload,
      });
    const rulesCommits = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.origin === 'rules');
    const values = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}/field-values`, { token: h.serviceJwt() })).json
        .values as Record<string, unknown>;
    const participant = async (doc: string, owner: string, pid: string) =>
      (
        (await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner })).json
          .participants as Array<Record<string, unknown>>
      ).find((p) => p.id === pid)!;
    const events = (name: string, doc: string) =>
      h.events.of(`dep.workflow.${name}.v1`).filter((e) => e.subject === doc);

    it.skipIf(skip)(
      'refuses a participant whose fields do not pass, lists each field and rule, and writes nothing (criterion 1)',
      async () => {
        const { doc, owner, ref } = await running(false);
        const head = (await h.parts.logs.head(ref)).seq;
        const r = await complete(doc, 'p1');
        expect(r.status, r.text).toBe(400);
        expect(r.json.code).toBe('validation_failed');
        const found = r.json.violations as Array<{ path: string; rule: string }>;
        expect(found).toEqual(
          expect.arrayContaining([
            { path: '/fields/tenant.name', rule: 'required' },
            { path: '/fields/tenant.code', rule: expect.stringContaining('pattern') },
          ]),
        );
        // The fields of the other role are not this participant's to check, and nothing was written.
        expect(found.every((v) => !v.path.includes('landlord'))).toBe(true);
        expect((await h.parts.logs.head(ref)).seq).toBe(head);
        expect(await rulesCommits(ref)).toHaveLength(0);
        expect((await values(doc))['tenant.total']).toBeNull();
        // The participant stays active.
        expect(await participant(doc, owner, 'p1')).toMatchObject({ state: 'active' });
        expect(events('participant_completed', doc)).toHaveLength(0);
        expect(
          (await h.parts.evidence!.list(h.tenant, doc)).filter((e) => e.item === 'completed'),
        ).toHaveLength(0);
      },
      60_000,
    );

    it.skipIf(skip)(
      'writes the formula results and clears hidden values in one rules commit, completes the participant, moves the order on, and a second call changes nothing (criteria 2 to 4, 6 and 7)',
      async () => {
        const { doc, owner, ref } = await running(true);
        // Not the participant's turn, not the participant's token, no body: refused.
        expect((await complete(doc, 'p2')).status).toBe(403);
        expect((await complete(doc, 'ap')).status).toBe(403);
        expect(
          (
            await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
              token: token(doc, 'p2'),
              body: {},
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
              token: h.serviceJwt(),
              body: {},
            })
          ).status,
        ).toBe(403);
        expect((await complete(doc, 'p1', { completedSeq: 1 })).status).toBe(400);
        expect(await rulesCommits(ref)).toHaveLength(0);

        const before = await values(doc);
        expect(before['tenant.secret']).toBe('hush');
        const first = await complete(doc, 'p1');
        expect(first.status, first.text).toBe(200);

        // One commit with origin rules: the formula result and the hidden value cleared (criterion 2, 3).
        const commits = await rulesCommits(ref);
        expect(commits).toHaveLength(1);
        const surrogate = (await h.parts.users.resolve(h.tenant, 'sub-p1')).surrogate;
        expect(commits[0]!.user).toBe(surrogate);
        const after = await values(doc);
        expect(after['tenant.total']).toMatch(/^6(\.0+)?$/);
        expect(after['tenant.secret']).toBeNull();
        expect(after['landlord.note']).toBe('keep');
        expect(after['tenant.name']).toBe('Ada');

        // The participant is completed at the commit, the next order is active (criterion 2, 4).
        const p1 = await participant(doc, owner, 'p1');
        expect(p1).toMatchObject({ state: 'completed', completedSeq: commits[0]!.seq });
        expect(first.json.participants.find((p: { id: string }) => p.id === 'p1')).toMatchObject({
          state: 'completed',
          completedSeq: commits[0]!.seq,
        });
        expect(await participant(doc, owner, 'p2')).toMatchObject({ state: 'active' });
        expect(first.json.state).toBe('in_progress');
        expect(events('participant_completed', doc)).toHaveLength(1);
        expect(events('participant_completed', doc)[0]!.data).toMatchObject({ participant: 'p1' });
        expect(
          events('participant_activated', doc).filter((e) => e.data.participant === 'p2'),
        ).toHaveLength(1);
        expect(events('completed', doc)).toHaveLength(0);
        const evidence = (await h.parts.evidence!.list(h.tenant, doc)).filter(
          (e) => e.item === 'completed',
        );
        expect(evidence).toHaveLength(1);
        expect(evidence[0]!.participant).toBe('p1');

        // A second call changes nothing (criterion 6).
        const again = await complete(doc, 'p1');
        expect(again.status, again.text).toBe(200);
        expect(again.json.participants).toEqual(first.json.participants);
        expect(await rulesCommits(ref)).toHaveLength(1);
        expect(events('participant_completed', doc)).toHaveLength(1);
        expect(
          (await h.parts.evidence!.list(h.tenant, doc)).filter((e) => e.item === 'completed'),
        ).toHaveLength(1);

        // The second participant has nothing left to write: no second rules commit, and the
        // approver's completion is an approval with no fields to check (criterion 7).
        const second = await complete(doc, 'p2');
        expect(second.status, second.text).toBe(200);
        expect(await rulesCommits(ref)).toHaveLength(1);
        const commits1Seq = commits[0]!.seq;
        expect(await participant(doc, owner, 'ap')).toMatchObject({ state: 'active' });
        const last = await complete(doc, 'ap');
        expect(last.status, last.text).toBe(200);
        // The last completion moves the workflow to `completed` and raises `completed` (criterion 4).
        expect(last.json.state).toBe('completed');
        expect(events('completed', doc)).toHaveLength(1);
        expect(events('participant_completed', doc)).toHaveLength(3);
        // The approver completes at the head they read, which holds the rules commit; the control
        // commit of the `completed` lock follows it.
        expect((await participant(doc, owner, 'ap')).completedSeq).toBe(commits1Seq);
        const control = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');
        expect(control.length).toBeGreaterThan(0);
        expect(control.at(-1)!.seq).toBeGreaterThan(commits1Seq);
        // A call after the workflow ended still changes nothing.
        expect((await complete(doc, 'ap')).status).toBe(200);
        expect(events('completed', doc)).toHaveLength(1);
      },
      90_000,
    );

    it.skipIf(skip)(
      'applies the rules commit once when the process stops before the participant is marked (criterion 5)',
      async () => {
        const { doc, owner, ref } = await running(true);
        const store = h.parts.workflows!;
        const real = store.transition.bind(store);
        let crash = true;
        store.transition = async (...args) => {
          if (crash) {
            crash = false;
            throw new Error('stopped after the rules commit');
          }
          return real(...args);
        };
        try {
          const stopped = await complete(doc, 'p1');
          expect(stopped.status).toBe(500);
          // The commit is stored; the participant is not yet marked.
          expect(await rulesCommits(ref)).toHaveLength(1);
          expect(await participant(doc, owner, 'p1')).toMatchObject({ state: 'active' });
          expect(events('participant_completed', doc)).toHaveLength(0);

          const retried = await complete(doc, 'p1');
          expect(retried.status, retried.text).toBe(200);
        } finally {
          store.transition = real;
        }
        expect(await rulesCommits(ref)).toHaveLength(1);
        const p1 = await participant(doc, owner, 'p1');
        expect(p1).toMatchObject({ state: 'completed' });
        expect(p1.completedSeq).toBe((await h.parts.logs.head(ref)).seq);
        expect(events('participant_completed', doc)).toHaveLength(1);
        expect((await values(doc))['tenant.total']).toMatch(/^6(\.0+)?$/);
      },
      60_000,
    );
  });
}
