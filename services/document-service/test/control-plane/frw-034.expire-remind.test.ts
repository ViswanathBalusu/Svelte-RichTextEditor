// FRW-034 through the real service: the deadline and the reminders of a running workflow, and the
// action `remind`, against the real data plane with a participant connected, on memory storage and,
// when the test environment is up, on PostgreSQL in Podman. The clock is the service clock of the
// harness (`h.advance`); nothing here reads the wall clock for the schedule.
// docs/adr/0389-w4-FRW-034-expire-and-remind.md (proposed).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import { recordCompletion, recordFirstView } from '../../src/workflow/progress.ts';
import { sweepTenant, type SweepDeps } from '../../src/workflow/schedule-sweep.ts';
import { recordVoid } from '../../src/workflow/stop.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TENANT_FIELD = 'ffTenant00000001';
const DAY = 86_400_000;
/** The room the clock is given at each boundary: real time passes between the calls of a test. */
const MARGIN = 60_000;

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

const BODY = (doc: string, extra: Record<string, unknown>) => ({
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
  ...extra,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`deadline and reminders (${storage}; FRW-034)`, async () => {
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

    const sweepDeps = (): SweepDeps => ({
      workflows: h.parts.workflows!,
      reminders: h.parts.reminders!,
      grants: h.parts.grants,
      logs: h.parts.logs,
      notifier: h.service.dataPlane,
      audit: h.parts.audit,
      now: h.now,
      controlWaitMs: 5000,
      events: h.events,
    });
    const sweep = () => sweepTenant(sweepDeps(), h.tenant);

    /** A sent workflow with the given deadline (ms from now) and reminder timers. */
    async function sent(
      deadlineInMs: number | null,
      reminders: { firstAfterDays: number; everyDays: number } | null = {
        firstAfterDays: 3,
        everyDays: 2,
      },
    ) {
      const content = document();
      const doc = await h.createDocument({ content });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-034-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, {
          ...(deadlineInMs !== null
            ? { deadline: new Date(h.now() + deadlineInMs).toISOString() }
            : {}),
          ...(reminders !== null ? { reminders } : {}),
        }),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(r.status, r.text).toBe(200);
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    const reminded = (doc: string) =>
      h.events.of('dep.workflow.reminder_due.v1').filter((e) => e.subject === doc);
    const state = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.workflows!.read(ref.tenant, ref.doc))!;
    const controls = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control').length;
    // The sweep covers every workflow of the tenant, so each test looks at its own document only.
    const mine = (r: { reminded: readonly { doc: string; participant: string }[] }, doc: string) =>
      r.reminded.filter((x) => x.doc === doc).map((x) => x.participant);

    it.skipIf(skip)(
      'raises reminder_due after firstAfterDays and then every everyDays, for the active participant only, once each (criteria 2 and 5)',
      async () => {
        const { doc, ref } = await sent(null);
        const at = (await state(ref)).participants.map((p) => [p.id, p.state, p.activatedAt]);
        // Only the first order is active, and it has the activation time of the send.
        expect(at.map((x) => [x[0], x[1]])).toEqual([
          ['p1', 'active'],
          ['p2', 'pending'],
          ['p3', 'pending'],
        ]);
        expect(typeof at[0]![2]).toBe('string');
        expect(at[1]![2]).toBeUndefined();

        h.advance(3 * DAY - MARGIN);
        expect(mine(await sweep(), doc)).toEqual([]);
        h.advance(MARGIN + 1000);
        expect(mine(await sweep(), doc)).toEqual(['p1']);
        // A second run at the same instant, or after a restart (new deps, same stores), adds none.
        expect(mine(await sweep(), doc)).toEqual([]);
        // Two instances at once: one raises it.
        h.advance(2 * DAY);
        const both = await Promise.all([sweep(), sweep()]);
        expect(both.flatMap((r) => mine(r, doc))).toEqual(['p1']);
        h.advance(2 * DAY - MARGIN);
        expect(mine(await sweep(), doc)).toEqual([]);
        h.advance(MARGIN + 1000);
        expect(mine(await sweep(), doc)).toEqual(['p1']);

        const events = reminded(doc);
        expect(events).toHaveLength(3);
        // The data names the workflow, the document, the participant, the seq and the chain head.
        expect(Object.keys(events[0]!.data).sort()).toEqual([
          'chainHead',
          'document',
          'participant',
          'seq',
          'workflow',
        ]);
        expect(events[0]!.data).toMatchObject({ document: doc, participant: 'p1' });
        expect(events[0]!.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
      },
    );

    it.skipIf(skip)(
      'raises one reminder for several that came due while nothing ran, and counts them all (criterion 5)',
      async () => {
        const { doc } = await sent(null);
        // Three days and four more: the reminders at 3, 5 and 7 days are all due.
        h.advance(7 * DAY);
        expect(mine(await sweep(), doc)).toEqual(['p1']);
        expect(mine(await sweep(), doc)).toEqual([]);
        expect(reminded(doc)).toHaveLength(1);
        h.advance(2 * DAY);
        expect(mine(await sweep(), doc)).toEqual(['p1']);
      },
    );

    it.skipIf(skip)(
      'moves the count of raised reminders by a compare and set: of many concurrent claims one wins, and a later activation starts again (criterion 5)',
      async () => {
        const store = h.parts.reminders!;
        const doc = uuid7();
        const anchor = 1_800_000_000_000;
        expect(await store.raised(h.tenant, doc, 'p1', anchor)).toBe(0);
        const wins = await Promise.all(
          Array.from({ length: 12 }, () => store.claim(h.tenant, doc, 'p1', anchor, 0, 1)),
        );
        expect(wins.filter(Boolean)).toHaveLength(1);
        expect(await store.raised(h.tenant, doc, 'p1', anchor)).toBe(1);
        // A stale count, a count that does not rise, and an earlier activation are refused.
        expect(await store.claim(h.tenant, doc, 'p1', anchor, 0, 2)).toBe(false);
        expect(await store.claim(h.tenant, doc, 'p1', anchor, 1, 1)).toBe(false);
        expect(await store.claim(h.tenant, doc, 'p1', anchor - 1, 0, 1)).toBe(false);
        expect(await store.claim(h.tenant, doc, 'p1', anchor, 1, 4)).toBe(true);
        // A later activation (after a correction) counts again from zero, once.
        expect(await store.raised(h.tenant, doc, 'p1', anchor + 5)).toBe(0);
        const again = await Promise.all(
          Array.from({ length: 12 }, () => store.claim(h.tenant, doc, 'p1', anchor + 5, 0, 1)),
        );
        expect(again.filter(Boolean)).toHaveLength(1);
        // Another participant and another document have counts of their own.
        expect(await store.raised(h.tenant, doc, 'p2', anchor)).toBe(0);
        expect(await store.raised(h.tenant, uuid7(), 'p1', anchor)).toBe(0);
      },
    );
    it.skipIf(skip)(
      'raises no reminder without both timers, and none for a participant who has completed or once the workflow has ended (criterion 4)',
      async () => {
        const none = await sent(null, null);
        h.advance(30 * DAY);
        expect(mine(await sweep(), none.doc)).toEqual([]);

        const { doc, ref, owner } = await sent(null);
        const transitionDeps = {
          workflows: h.parts.workflows!,
          grants: h.parts.grants,
          logs: h.parts.logs,
          notifier: h.service.dataPlane,
          audit: h.parts.audit,
          now: h.now,
          controlWaitMs: 5000,
        };
        expect(
          await recordFirstView(transitionDeps, { ref, actor: 'p1', participant: 'p1' }),
        ).toMatchObject({ ok: true });
        // p1 completes: p2 becomes active with its own activation time; p1 gets no more.
        const done = await recordCompletion(transitionDeps, {
          ref,
          actor: 'p1',
          participant: 'p1',
        });
        expect(done).toMatchObject({ ok: true });
        h.advance(3 * DAY - MARGIN);
        expect(mine(await sweep(), doc)).toEqual([]);
        h.advance(MARGIN + 1000);
        // Three days after p2 became active, not after the send; p1 has completed.
        expect(mine(await sweep(), doc)).toEqual(['p2']);

        // A voided workflow raises none.
        expect(
          await recordVoid(transitionDeps, { ref, actor: 'owner', reason: 'Stop' }),
        ).toMatchObject({ ok: true });
        h.advance(30 * DAY);
        expect(mine(await sweep(), doc)).toEqual([]);
        expect(owner).toBeTruthy();
      },
    );

    it.skipIf(skip)(
      'expires the workflow at the deadline: the state, the lock, one control commit, the event, and no more filling (criterion 1)',
      async () => {
        const { doc, ref } = await sent(DAY);
        const filler = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(filler);
        const token = h.userToken(
          { [doc]: 'filler' },
          { sub: 'sub-p1', wfp: 'p1', wfr: ['tenant'] },
        );
        expect((await filler.hello(token)).t).toBe('welcome');
        expect((await filler.open(1, doc)).t).toBe('ch.opened');
        const tree = schema.nodeFromJSON((document() as { doc: unknown }).doc);
        const field = posOf(tree, TENANT_FIELD);
        const set = (value: string) => ({ stepType: 'attr', pos: field, attr: 'value', value });
        const filled = await filler.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [set('Ada')],
        });
        expect(filled.t, JSON.stringify(filled)).toBe('sync.ack');

        const before = await controls(ref);
        h.advance(DAY - MARGIN);
        expect((await sweep()).expired).not.toContain(doc);
        // The participant who filled opened the document, which moved the workflow on (FRW-040).
        expect((await state(ref)).state).toBe('in_progress');
        h.advance(MARGIN + 1000);
        // Two instances at once: one expires it.
        const both = await Promise.all([sweep(), sweep()]);
        expect(both.flatMap((r) => r.expired).filter((d) => d === doc)).toEqual([doc]);
        expect(both.flatMap((r) => r.failed)).toEqual([]);

        const stored = await state(ref);
        expect(stored.state).toBe('expired');
        expect(stored.participants.map((p) => [p.id, p.state])).toEqual([
          ['p1', 'closed'],
          ['p2', 'closed'],
          ['p3', 'closed'],
        ]);
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('locked');
        expect(perms.workflowActive).toBe(false);
        expect(await controls(ref)).toBe(before + 1);
        const events = h.events.of('dep.workflow.expired.v1').filter((e) => e.subject === doc);
        expect(events).toHaveLength(1);
        expect(Object.keys(events[0]!.data).sort()).toEqual([
          'chainHead',
          'document',
          'seq',
          'workflow',
        ]);
        // The seq is that of the control commit the expiry wrote.
        const control = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control').at(-1)!;
        expect(events[0]!.data['seq']).toBe(control.seq);
        const audit = (
          await h.parts.audit!.query(h.tenant, { doc, kind: 'workflow.transition', limit: 100 })
        ).map((e) => e.data);
        expect(audit.at(-1)).toMatchObject({
          from: 'in_progress',
          to: 'expired',
          cause: 'deadline',
        });

        // A later run changes nothing, and the participant can no longer fill.
        h.advance(DAY);
        expect((await sweep()).expired).not.toContain(doc);
        expect(
          h.events.of('dep.workflow.expired.v1').filter((e) => e.subject === doc),
        ).toHaveLength(1);
        const refused = await filler.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [set('Bea')],
        });
        expect(refused.t).toBe('sync.reject');
        expect(refused.d).toMatchObject({ code: 'read_only' });
        // No reminder after the end.
        expect(mine(await sweep(), doc)).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'reads the deadline as an instant in UTC against the server clock, however the host writes it (criterion 6)',
      async () => {
        // The host writes the deadline with a `Z`, in a workflow whose time zone is far from UTC.
        // The schedule reads the instant: one hour from the server's time now, not from any local zone.
        const hour = 3_600_000;
        const deadline = new Date(h.now() + hour).toISOString();
        expect(deadline.endsWith('Z')).toBe(true);
        const second = await h.createDocument({ content: document() });
        const owner = h.userToken({ [second]: 'owner' }, { sub: `owner-034-${uuid7()}` });
        const made = await h.call('PUT', `/v1/documents/${second}/workflow`, {
          token: owner,
          body: { ...BODY(second, { deadline }), timeZone: 'Pacific/Auckland' },
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        expect(
          (await h.call('POST', `/v1/documents/${second}/workflow/send`, { token: owner })).status,
        ).toBe(200);
        h.advance(hour - MARGIN);
        expect((await sweep()).expired).not.toContain(second);
        h.advance(MARGIN + 1000);
        expect((await sweep()).expired).toContain(second);
      },
    );

    it.skipIf(skip)(
      'raises reminder_due at once for the action remind with manage, and refuses without it or in a draft (criterion 3)',
      async () => {
        const { doc, ref, owner } = await sent(null);
        const path = `/v1/documents/${doc}/workflow/remind`;
        const editor = h.userToken({ [doc]: 'editor' }, { sub: `ed-034-${uuid7()}` });
        const refused = await h.call('POST', path, { token: editor });
        expect(refused.status, refused.text).toBe(403);
        expect(reminded(doc)).toEqual([]);

        const rev = (await state(ref)).rev;
        const r = await h.call('POST', path, { token: owner });
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('sent');
        expect(reminded(doc).map((e) => e.data['participant'])).toEqual(['p1']);
        // Nothing is stored: the revision and the schedule's count are as they were.
        expect((await state(ref)).rev).toBe(rev);
        h.advance(3 * DAY);
        expect(mine(await sweep(), doc)).toEqual(['p1']);
        expect(reminded(doc)).toHaveLength(2);

        // A draft has nobody to remind.
        const content = document();
        const draft = await h.createDocument({ content });
        const dOwner = h.userToken({ [draft]: 'owner' }, { sub: `owner-034-${uuid7()}` });
        const made = await h.call('PUT', `/v1/documents/${draft}/workflow`, {
          token: dOwner,
          body: BODY(draft, {}),
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        const early = await h.call('POST', `/v1/documents/${draft}/workflow/remind`, {
          token: dOwner,
        });
        expect(early.status, early.text).toBe(409);
        expect(reminded(draft)).toEqual([]);
      },
    );
  });
}
