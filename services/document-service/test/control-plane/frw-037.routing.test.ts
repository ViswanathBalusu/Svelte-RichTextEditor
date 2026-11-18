// FRW-037 through the real service: routing rules of the workflow resource. A route adds or skips a
// participant by the value of a field; the routes are checked when the workflow is saved and
// evaluated when it is sent and when a participant completes. The real data plane applies the
// `rules` commit; an owner's channel is open to see `wf.changed`. Memory storage and, when the test
// environment is up, PostgreSQL in Podman. docs/adr/0405-w4-FRW-037-routing.md (proposed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { until } from '../data-plane/support.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  skipReason,
  startHarness,
  documentWithRegions,
  type Harness,
  type Storage,
} from './support.ts';

const TOTAL_ID = 'frLeaseTotal0001';

/** A document with the given roles and a number field `lease.total` of the tenant, stored as `total`. */
function document(opts: { roles: string[]; total?: string | null }): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  for (const role of opts.roles)
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#1F77B4' } });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pRouting00000001' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: TOTAL_ID,
          key: 'lease.total',
          kind: 'number',
          label: 'lease.total',
          assignee: 'tenant',
          required: false,
          value: opts.total ?? null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

/** The step that writes the tenant's `lease.total`, as a participant's fill commit does. */
const setTotal = (content: Record<string, unknown>, value: string) => ({
  stepType: 'attr',
  pos: posOf(schema.nodeFromJSON((content as { doc: unknown }).doc), TOTAL_ID),
  attr: 'value',
  value,
});
const over = (n: string) => ({ '>': [{ field: 'lease.total' }, n] });
const addApprover = (order: number) => ({ addParticipant: { role: 'approver', order } });
const skipRole = (role: string) => ({ skipParticipant: { role } });

const body = (
  doc: string,
  participants: Array<Record<string, unknown>>,
  routing: unknown[] | undefined,
) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cd2',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants,
  ...(routing !== undefined ? { routing } : {}),
});
const person = (pid: string, role: string, kind: string, order: number) => ({
  id: pid,
  roles: [role],
  kind,
  order,
  sub: `sub-${pid}`,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`routing rules of the workflow (${storage}; FRW-037)`, async () => {
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
    const owner = (doc: string) => h.userToken({ [doc]: 'owner' }, { sub: `owner-037-${doc}` });
    const put = (doc: string, b: unknown) =>
      h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner(doc),
        body: b,
        headers: { 'if-match': '"0"' },
      });
    const read = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner(doc) })).json as {
        state: string;
        participants: Array<Record<string, unknown>>;
      };
    const events = (name: string, doc: string) =>
      h.events.of(`dep.workflow.${name}.v1`).filter((e) => e.subject === doc);
    const controls = async (doc: string) =>
      (await h.parts.logs.read({ tenant: h.tenant, doc })).filter((c) => c.kind === 'control');
    const states = (c: DepClient) =>
      c.all('wf.changed', 1).map((m) => (m.d as { state: string }).state);
    /** The status of their own participant in each wf.changed a participant's channel received. */
    const own = (c: DepClient) =>
      c
        .all('wf.changed', 1)
        .map((m) => (m.d as { participant?: { state: string } }).participant?.state);

    /** A participant's channel on the document. */
    async function connect(doc: string, pid: string): Promise<DepClient> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token(doc, pid))).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      return c;
    }

    /** An owner's channel on the document, so that `wf.changed` can be seen. */
    async function watch(doc: string): Promise<DepClient> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(owner(doc))).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      return c;
    }

    async function sentWorkflow(
      content: Record<string, unknown>,
      participants: Array<Record<string, unknown>>,
      routing: unknown[],
      first: string,
    ) {
      const doc = await h.createDocument({ content });
      const made = await put(doc, body(doc, participants, routing));
      expect(made.status, made.text).toBe(201);
      const client = await watch(doc);
      const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, {
        token: owner(doc),
      });
      expect(sent.status, sent.text).toBe(200);
      // The first participant opens the document, so the workflow is in progress.
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token(doc, first))).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        if ((await read(doc)).state === 'in_progress') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const ref = { tenant: h.tenant, doc };
      /** The first participant writes the total, as a fill commit on their channel. */
      const fillTotal = async (value: string) => {
        const base = (await h.parts.logs.head(ref)).seq;
        const ack = await c.submit(1, { base, steps: [setTotal(content, value)] });
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
      };
      return { doc, client, ref, fillTotal, participant: c };
    }

    const complete = (doc: string, pid: string) =>
      h.call('POST', `/v1/documents/${doc}/workflow/participants/${pid}/complete`, {
        token: token(doc, pid),
        body: {},
      });

    it.skipIf(skip)(
      'refuses a route that names a key or a role that does not exist, and stores nothing (criterion 3)',
      async () => {
        const doc = await h.createDocument({
          content: document({ roles: ['tenant', 'approver'], total: '1' }),
        });
        const people = [person('p1', 'tenant', 'filler', 1)];
        const badKey = await put(
          doc,
          body(doc, people, [
            { when: { '>': [{ field: 'lease.amount' }, '1'] }, then: [addApprover(2)] },
          ]),
        );
        expect(badKey.status, badKey.text).toBe(400);
        expect(badKey.json.code).toBe('validation_failed');
        expect(badKey.json.violations).toEqual([
          { path: '/routing/0/when/>/0', rule: expect.stringContaining('unknown_field') },
        ]);
        const badRole = await put(
          doc,
          body(doc, people, [
            { when: over('1'), then: [{ addParticipant: { role: 'ghost', order: 2 } }] },
            { when: over('1'), then: [skipRole('phantom')] },
          ]),
        );
        expect(badRole.status, badRole.text).toBe(400);
        const paths = (badRole.json.violations as Array<{ path: string }>).map((v) => v.path);
        expect(paths).toEqual([
          expect.stringMatching(/^\/routing\/0\/then\/0/),
          expect.stringMatching(/^\/routing\/1\/then\/0/),
        ]);
        // Nothing was stored: the document still has no workflow.
        const gone = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner(doc) });
        expect(gone.status).toBe(404);

        const good = await put(
          doc,
          body(doc, people, [{ when: over('1'), then: [addApprover(2)] }]),
        );
        expect(good.status, good.text).toBe(201);
        expect(good.json.routing).toEqual([{ when: over('1'), then: [addApprover(2)] }]);
      },
      60_000,
    );

    it.skipIf(skip)(
      'adds the participant when the send finds the condition true, waits for the order, and records it (criteria 1 and 4)',
      async () => {
        const doc = await h.createDocument({
          content: document({ roles: ['tenant', 'approver', 'witness'], total: '60000' }),
        });
        const people = [person('p1', 'tenant', 'filler', 1), person('p3', 'witness', 'filler', 3)];
        expect(
          (await put(doc, body(doc, people, [{ when: over('50000'), then: [addApprover(2)] }])))
            .status,
        ).toBe(201);
        const client = await watch(doc);
        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, {
          token: owner(doc),
        });
        expect(sent.status, sent.text).toBe(200);

        const added = (sent.json.participants as Array<Record<string, unknown>>).find(
          (p) => p.id === 'route0_approver',
        )!;
        expect(added).toMatchObject({
          roles: ['approver'],
          kind: 'approver',
          order: 2,
          addedBy: 0,
          state: 'pending',
        });
        expect(added.sub).toBeUndefined();
        // Order 1 is active; the added participant at order 2 comes before the one at order 3.
        expect(
          (sent.json.participants as Array<{ id: string; state: string }>).map((p) => [
            p.id,
            p.state,
          ]),
        ).toEqual([
          ['p1', 'active'],
          ['p3', 'pending'],
          ['route0_approver', 'pending'],
        ]);
        expect(
          events('participant_activated', doc).map(
            (e) => (e.data as { participant: string }).participant,
          ),
        ).toEqual(['p1']);
        // The routing change is a control commit, and the owner's channel is told.
        expect((await controls(doc)).length).toBeGreaterThan(0);
        await until(() => states(client).includes('sent'), 5000, 'wf.changed for the send');
      },
      60_000,
    );

    it.skipIf(skip)(
      'adds the participant when a completion makes the condition true, and activates it by the order (criterion 1, 4)',
      async () => {
        const people = [person('p1', 'tenant', 'filler', 1), person('p2', 'landlord', 'filler', 3)];
        const { doc, ref, fillTotal, participant } = await sentWorkflow(
          document({ roles: ['tenant', 'landlord', 'approver'] }),
          people,
          [{ when: over('50000'), then: [addApprover(2)] }],
          'p1',
        );
        // Not true yet: the total is empty. The send added nobody.
        expect((await read(doc)).participants.map((p) => p.id)).toEqual(['p1', 'p2']);
        await fillTotal('60000');
        const controlBefore = (await controls(doc)).length;

        const done = await complete(doc, 'p1');
        expect(done.status, done.text).toBe(200);
        const after = done.json.participants as Array<{ id: string; state: string }>;
        // The tenant wrote 60000, the route added the approver at order 2, and that, not the
        // landlord at order 3, is who is active now.
        expect(after.map((p) => [p.id, p.state])).toEqual([
          ['p1', 'completed'],
          ['p2', 'pending'],
          ['route0_approver', 'active'],
        ]);
        expect(
          events('participant_activated', doc).map(
            (e) => (e.data as { participant: string }).participant,
          ),
        ).toEqual(['p1', 'route0_approver']);
        // One control commit for the routing change, and `wf.changed` for the transition.
        expect((await controls(doc)).length).toBe(controlBefore + 1);
        await until(
          () => own(participant).includes('completed'),
          5000,
          'wf.changed for the routing',
        );
        expect(done.json.state).toBe('in_progress');
        expect((await h.parts.logs.head(ref)).seq).toBeGreaterThan(0);
      },
      90_000,
    );

    it.skipIf(skip)(
      'writes no control commit for a completion that routing leaves as it was',
      async () => {
        const people = [person('p1', 'tenant', 'filler', 1), person('p2', 'landlord', 'filler', 2)];
        const { doc, fillTotal } = await sentWorkflow(
          document({ roles: ['tenant', 'landlord', 'approver'] }),
          people,
          [{ when: over('90000'), then: [addApprover(2)] }],
          'p1',
        );
        await fillTotal('60000');
        const controlBefore = (await controls(doc)).length;
        const done = await complete(doc, 'p1');
        expect(done.status, done.text).toBe(200);
        expect(
          (done.json.participants as Array<{ id: string; state: string }>).map((p) => [
            p.id,
            p.state,
          ]),
        ).toEqual([
          ['p1', 'completed'],
          ['p2', 'active'],
        ]);
        expect((await controls(doc)).length).toBe(controlBefore);
      },
      90_000,
    );

    it.skipIf(skip)(
      'skips a participant when the send finds the condition true, and the next order is active (criterion 2)',
      async () => {
        const doc = await h.createDocument({
          content: document({ roles: ['tenant', 'landlord'], total: '60000' }),
        });
        const people = [person('p1', 'landlord', 'filler', 1), person('p2', 'tenant', 'filler', 2)];
        expect(
          (
            await put(
              doc,
              body(doc, people, [{ when: over('50000'), then: [skipRole('landlord')] }]),
            )
          ).status,
        ).toBe(201);
        const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, {
          token: owner(doc),
        });
        expect(sent.status, sent.text).toBe(200);
        expect(
          (sent.json.participants as Array<{ id: string; state: string }>).map((p) => [
            p.id,
            p.state,
          ]),
        ).toEqual([
          ['p1', 'skipped'],
          ['p2', 'active'],
        ]);
        expect(sent.json.participants[0].skippedBy).toBe(0);
        expect(
          events('participant_activated', doc).map(
            (e) => (e.data as { participant: string }).participant,
          ),
        ).toEqual(['p2']);
      },
      60_000,
    );

    it.skipIf(skip)(
      'skips a participant when a completion makes the condition true, and the workflow goes on to the next order (criterion 2)',
      async () => {
        const people = [
          person('p1', 'tenant', 'filler', 1),
          person('p2', 'landlord', 'filler', 2),
          person('p3', 'witness', 'approver', 3),
        ];
        const { doc, fillTotal } = await sentWorkflow(
          document({ roles: ['tenant', 'landlord', 'witness'] }),
          people,
          [{ when: over('50000'), then: [skipRole('landlord')] }],
          'p1',
        );
        const landlord = await connect(doc, 'p2');
        await fillTotal('60000');
        const done = await complete(doc, 'p1');
        expect(done.status, done.text).toBe(200);
        expect(
          (done.json.participants as Array<{ id: string; state: string }>).map((p) => [
            p.id,
            p.state,
          ]),
        ).toEqual([
          ['p1', 'completed'],
          ['p2', 'skipped'],
          ['p3', 'active'],
        ]);
        expect(
          events('participant_activated', doc).map(
            (e) => (e.data as { participant: string }).participant,
          ),
        ).toEqual(['p1', 'p3']);
        // The skipped participant is told there is nothing left for them, and cannot act,
        await until(() => own(landlord).includes('closed'), 5000, 'wf.changed for the skip');
        // and the last one completing ends the workflow.
        expect((await complete(doc, 'p2')).status).toBe(403);
        const last = await complete(doc, 'p3');
        expect(last.status, last.text).toBe(200);
        expect(last.json.state).toBe('completed');
        expect(events('completed', doc)).toHaveLength(1);
      },
      90_000,
    );
  });
}
