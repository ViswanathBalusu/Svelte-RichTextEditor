// FRW-031 through the real service (criteria 2 to 6; FRW-035 on a live channel): the first view of a
// participant moves a `sent` workflow to `in_progress` and is recorded once; the completion of the
// lowest order activates the next order together, raises the events and pushes `wf.changed` to the
// open channel; the last participant who must act moves the workflow to `completed`.
// `recordFirstView` and `recordCompletion` run against the real data plane with a connected room,
// on memory storage and, when the test environment is up, on PostgreSQL in Podman.
// docs/adr/0384-w4-FRW-031-progression.md (proposed).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { until } from '../data-plane/support.ts';
import { recordFirstView, recordCompletion } from '../../src/workflow/progress.ts';
import { recordTransition, type TransitionDeps } from '../../src/workflow/transitions.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const participant = (id: string, kind: string, order: number) => ({
  id,
  roles: ['role_tenant'],
  kind,
  order,
});

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    participant('one', 'signer', 1),
    participant('two', 'signer', 2),
    participant('three', 'approver', 2),
    participant('copy', 'cc', 3),
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`how a sent workflow progresses (${storage}; FRW-031)`, async () => {
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

    /** A sent workflow (order 1 active, as the send route leaves it) and an owner on its channel. */
    async function sent() {
      const doc = await h.createDocument();
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-031-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(owner)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      const ref = { tenant: h.tenant, doc };
      const view = (await h.parts.workflows!.read(h.tenant, doc))!;
      const out = await recordTransition(deps(), {
        ref,
        actor: 'alice',
        from: view,
        write: {
          to: 'sent',
          sentSeq: (await h.parts.logs.head(ref)).seq,
          sentHash: 'sha256:' + '0'.repeat(64),
          participants: view.participants.map((p) => ({
            ...p,
            state: p.id === 'one' ? 'active' : 'pending',
          })),
        },
      });
      expect(out.ok).toBe(true);
      return { doc, ref, owner, client: c };
    }

    const states = (c: DepClient) =>
      c.all('wf.changed', 1).map((m) => (m.d as { state: string }).state);

    it.skipIf(skip)(
      'moves sent to in_progress at the first view, records the time once and raises participant_viewed (criterion 4)',
      async () => {
        const { ref, client } = await sent();
        await until(() => states(client).length >= 1, 5000, 'wf.changed for the send');
        expect(states(client)).toEqual(['sent']);

        const first = await recordFirstView(deps(), { ref, actor: 'one', participant: 'one' });
        expect(first).toMatchObject({ ok: true, changed: true });
        if (!first.ok) return;
        expect(first.resource.state).toBe('in_progress');
        const one = first.resource.participants.find((p) => p.id === 'one')!;
        expect(one.firstViewedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
        expect(first.raised).toEqual([{ name: 'participant_viewed', participant: 'one' }]);
        await until(() => states(client).length >= 2, 5000, 'wf.changed for the first view');
        expect(states(client)).toEqual(['sent', 'in_progress']);

        // A second view by the same participant stores and raises nothing.
        const again = await recordFirstView(deps(), { ref, actor: 'one', participant: 'one' });
        expect(again).toMatchObject({ ok: true, changed: false, raised: [] });
        const stored = (await h.parts.workflows!.read(ref.tenant, ref.doc))!;
        expect(stored.participants.find((p) => p.id === 'one')!.firstViewedAt).toBe(
          one.firstViewedAt,
        );
        expect(stored.rev).toBe(first.resource.rev);

        // The next participant's first view is recorded and raised too, in the same state.
        const second = await recordFirstView(deps(), { ref, actor: 'two', participant: 'two' });
        expect(second).toMatchObject({ ok: true, changed: true });
        if (second.ok) expect(second.resource.state).toBe('in_progress');
        // A name that is no participant is refused.
        expect(
          await recordFirstView(deps(), { ref, actor: 'x', participant: 'nobody' }),
        ).toMatchObject({ ok: false, problem: { code: 'forbidden' } });
      },
    );

    it.skipIf(skip)(
      "a completion is not refused when another participant's first view is stored between its read and its write (CI run 45931204248)",
      async () => {
        const { ref } = await sent();
        await recordFirstView(deps(), { ref, actor: 'one', participant: 'one' });
        // The first read of the completion is followed at once by the first view of "two", which
        // moves the row, so that the completion's write finds it changed.
        const real = deps();
        let raced = false;
        const workflows = new Proxy(real.workflows, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key);
            if (key !== 'read' || typeof value !== 'function') {
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (...args: unknown[]) => {
              const seen: unknown = await value.apply(target, args);
              if (!raced) {
                raced = true;
                await recordFirstView(real, { ref, actor: 'two', participant: 'two' });
              }
              return seen;
            };
          },
        });
        const out = await recordCompletion(
          { ...real, workflows },
          { ref, actor: 'one', participant: 'one' },
        );
        expect(raced).toBe(true);
        expect(out).toMatchObject({ ok: true, changed: true });
        const stored = (await h.parts.workflows!.read(ref.tenant, ref.doc))!;
        const marks = Object.fromEntries(stored.participants.map((p) => [p.id, p.state]));
        expect(marks['one']).toBe('completed');
        expect(stored.participants.find((p) => p.id === 'two')!.firstViewedAt).toBeDefined();
      },
    );

    it.skipIf(skip)(
      'activates the next order together, raises the events and pushes wf.changed; the last completion completes the workflow (criteria 2, 3, 5 and 6)',
      async () => {
        const { ref, client } = await sent();
        await recordFirstView(deps(), { ref, actor: 'one', participant: 'one' });

        // The order 2 participants cannot complete before order 1 has, and a cc never can.
        for (const who of ['two', 'three', 'copy'])
          expect(
            await recordCompletion(deps(), { ref, actor: who, participant: who }),
          ).toMatchObject({ ok: false, problem: { code: 'forbidden' } });

        const one = await recordCompletion(deps(), {
          ref,
          actor: 'one',
          participant: 'one',
          completedSeq: 7,
        });
        expect(one.ok).toBe(true);
        if (!one.ok) return;
        expect(one.raised).toEqual([
          { name: 'participant_completed', participant: 'one' },
          { name: 'participant_activated', participant: 'two' },
          { name: 'participant_activated', participant: 'three' },
        ]);
        const marks = Object.fromEntries(
          one.resource.participants.map((p) => [p.id, [p.state, p.completedSeq]]),
        );
        expect(marks).toEqual({
          one: ['completed', 7],
          two: ['active', undefined],
          three: ['active', undefined],
          copy: ['pending', undefined],
        });
        // Completing again changes nothing: the participant is no longer active.
        expect(
          await recordCompletion(deps(), { ref, actor: 'one', participant: 'one' }),
        ).toMatchObject({ ok: false, problem: { code: 'forbidden' } });

        // Either of the two may complete first: the approver does, without any field to check.
        const three = await recordCompletion(deps(), {
          ref,
          actor: 'three',
          participant: 'three',
        });
        expect(three).toMatchObject({ ok: true });
        if (!three.ok) return;
        expect(three.resource.state).toBe('in_progress');
        expect(three.raised).toEqual([{ name: 'participant_completed', participant: 'three' }]);

        const two = await recordCompletion(deps(), { ref, actor: 'two', participant: 'two' });
        expect(two).toMatchObject({ ok: true });
        if (!two.ok) return;
        expect(two.resource.state).toBe('completed');
        expect(two.raised).toEqual([
          { name: 'participant_completed', participant: 'two' },
          { name: 'completed' },
        ]);
        // The lock of a completed workflow: locked, nobody fills any more.
        const perms = await h.parts.grants.current(ref);
        expect(perms).toMatchObject({ documentState: 'locked', workflowActive: false });
        // After completion nothing moves.
        expect(
          await recordCompletion(deps(), { ref, actor: 'copy', participant: 'copy' }),
        ).toMatchObject({ ok: false });

        // The open channel was told of every state it passed through, in order, without a reload.
        await until(() => states(client).includes('completed'), 5000, 'wf.changed for completed');
        expect(states(client)).toEqual(['sent', 'in_progress', 'completed']);

        // SYN-004 criterion 1: the send, the first view and each of the three completions (two of
        // which leave the lock as it was) are control commits with no steps, one each, in log order.
        for (const out of [one, three, two]) expect(out.control).not.toBeNull();
        const controls = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');
        expect(controls).toHaveLength(5);
        expect(controls.every((c) => c.steps.length === 0)).toBe(true);
        const seqs = controls.map((c) => c.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(5);
        expect(new Set(controls.map((c) => c.revision)).size).toBe(5);
        expect(one.control!.seq).toBe(controls[2]!.seq);
        expect(two.control!.seq).toBe(controls[4]!.seq);
      },
    );

    it.skipIf(skip)(
      'shows the current state to a channel opened later (FRW-035 criterion 4)',
      async () => {
        const { doc, ref, owner } = await sent();
        await recordFirstView(deps(), { ref, actor: 'one', participant: 'one' });
        const late = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(late);
        await late.hello(owner);
        const opened = await late.open(1, doc);
        expect(opened.t).toBe('ch.opened');
        expect((opened.d as { workflow?: unknown }).workflow).toEqual({ state: 'in_progress' });
      },
    );
  });
}
