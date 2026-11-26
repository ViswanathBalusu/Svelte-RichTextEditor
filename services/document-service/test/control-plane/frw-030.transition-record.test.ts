// FRW-030: a workflow transition is recorded as a control commit, audited, and repeatable after a
// stop between its two writes (criteria 3, 4 and 5; docs/adr/0382-w4-FRW-030-transition-record.md,
// proposed). `recordTransition` is run against the real data plane with a connected room, on
// memory storage and, when the test environment is up, on PostgreSQL in Podman (infra/test-env.ps1).
// The send route (FRW-027) is the first caller; here the function is called directly, with two
// different transitions, so the test shows the recorder and not one route.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { recordTransition, type TransitionDeps } from '../../src/workflow/transitions.ts';
import type { WorkflowResourceView } from '../../src/workflow/workflow-resource.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1 }],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`workflow transitions as control commits (${storage}; FRW-030)`, async () => {
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

    const deps = (extra: Partial<TransitionDeps> = {}): TransitionDeps => ({
      workflows: h.parts.workflows!,
      grants: h.parts.grants,
      logs: h.parts.logs,
      notifier: h.service.dataPlane,
      audit: h.parts.audit,
      now: h.now,
      controlWaitMs: 5000,
      ...extra,
    });

    /** A document with a draft workflow and an owner connected to its room. */
    async function draft(connect = true) {
      const doc = await h.createDocument();
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-030-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      if (connect) {
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        expect((await c.hello(owner)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
      }
      const ref = { tenant: h.tenant, doc };
      const view = (await h.parts.workflows!.read(h.tenant, doc))!;
      return { doc, ref, view };
    }

    const controls = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');

    it.skipIf(skip)(
      'writes one control commit with no steps for a send, in log order, and reads its seq and the chain head back (criteria 5 and 4)',
      async () => {
        const { doc, ref, view } = await draft();
        const headBefore = (await h.parts.logs.head(ref)).seq;
        const out = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: view,
          write: { to: 'sent', sentSeq: headBefore, sentHash: 'sha256:' + '0'.repeat(64) },
        });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.resource.state).toBe('sent');
        expect(out.control).not.toBeNull();
        const found = await controls(ref);
        expect(found).toHaveLength(1);
        expect(found[0]!.steps).toEqual([]);
        expect(found[0]!.seq).toBe(headBefore + 1);
        expect(found[0]!.revision).toBe(out.revision);
        expect(out.control!.seq).toBe(found[0]!.seq);
        expect(out.control!.chainHead).toMatch(/^[0-9a-f]{64}$/);

        // The audit trail has the transition with actor, document and server time (criterion 4).
        const before = h.now() - 60_000;
        const events = await h.parts.audit!.query(h.tenant, {
          doc,
          kind: 'workflow.transition',
          limit: 10,
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor: 'alice',
          doc,
          kind: 'workflow.transition',
          data: { from: 'draft', to: 'sent', rev: 2 },
        });
        expect(events[0]!.at).toBeGreaterThan(before);
      },
    );

    it.skipIf(skip)(
      'records a second and a third transition (a first view, a void) the same way, after the send, one control commit each, also the one that changes no lock (criteria 1 and 4)',
      async () => {
        const { doc, ref, view } = await draft();
        const sent = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: view,
          write: { to: 'sent', sentSeq: 0, sentHash: 'sha256:' + '1'.repeat(64) },
        });
        expect(sent.ok).toBe(true);
        if (!sent.ok) return;
        // `in_progress` has the lock of `sent`: the lock does not change, and the transition still
        // has its own control commit (FRW-030 criterion 1).
        const open = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: sent.resource,
          write: { to: 'in_progress' },
        });
        expect(open.ok).toBe(true);
        if (!open.ok) return;
        expect(open.revision).toBe(3);
        expect(open.control).not.toBeNull();
        expect(await controls(ref)).toHaveLength(2);
        // `voided` keeps the document locked and ends the fill: one more grants revision and commit.
        const voided = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: open.resource,
          write: { to: 'voided' },
        });
        expect(voided.ok).toBe(true);
        if (!voided.ok) return;
        expect(voided.control).not.toBeNull();
        const found = await controls(ref);
        expect(found.map((c) => c.revision)).toEqual([2, 3, 4]);
        expect(found.every((c) => c.steps.length === 0)).toBe(true);
        expect(found[1]!.seq).toBeGreaterThan(found[0]!.seq);
        expect(found[2]!.seq).toBeGreaterThan(found[1]!.seq);
        const kinds = (
          await h.parts.audit!.query(h.tenant, { doc, kind: 'workflow.transition', limit: 10 })
        ).map((e) => e.data['to']);
        expect(kinds).toEqual(['sent', 'in_progress', 'voided']);
        void doc;
      },
    );

    it.skipIf(skip)(
      'repeats cleanly after a stop between the lock and the state write: one control commit, the state moves once',
      async () => {
        const { ref, view } = await draft();
        const crash = new Error('stopped between the lock and the state');
        await expect(
          recordTransition(
            deps({
              afterLock: () => {
                throw crash;
              },
            }),
            { ref, actor: 'alice', from: view, write: { to: 'sent', sentSeq: 0, sentHash: 'h' } },
          ),
        ).rejects.toBe(crash);
        // The lock is stored, the workflow has not moved.
        const mid = (await h.parts.workflows!.read(h.tenant, ref.doc))!;
        expect(mid.state).toBe('draft');
        expect((await h.parts.grants.current(ref)).workflowActive).toBe(true);
        // The caller repeats: the lock is in force, so no second grants revision and no second commit.
        const again = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: mid,
          write: { to: 'sent', sentSeq: 0, sentHash: 'sha256:' + '2'.repeat(64) },
        });
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.revision).toBeNull();
        // The room wrote the commit of the first attempt's revision; it is there exactly once.
        const deadline = Date.now() + 5000;
        while ((await controls(ref)).length < 1 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        expect(await controls(ref)).toHaveLength(1);
        expect((await h.parts.workflows!.read(h.tenant, ref.doc))!.state).toBe('sent');
        // A third attempt from the stale state is refused: the state moves once.
        const stale = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: mid,
          write: { to: 'sent', sentSeq: 0, sentHash: 'h' },
        });
        expect(stale.ok).toBe(false);
        expect(stale.ok === false && stale.problem.code).toBe('conflict');
      },
    );

    it.skipIf(skip)(
      'repeats cleanly after a stop for a transition that keeps the lock: the repeat finds the revision of the first attempt, one control commit, the state moves once (criterion 3)',
      async () => {
        const { ref, view } = await draft();
        const sent = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: view,
          write: { to: 'sent', sentSeq: 0, sentHash: 'sha256:' + '3'.repeat(64) },
        });
        expect(sent.ok).toBe(true);
        if (!sent.ok) return;
        expect(await controls(ref)).toHaveLength(1);

        // `sent` to `in_progress` keeps the lock: the transition raises a grants revision with nothing
        // changed, and the process stops after that and before the workflow row moves.
        const crash = new Error('stopped after the revision, before the state');
        await expect(
          recordTransition(
            deps({
              afterLock: () => {
                throw crash;
              },
            }),
            { ref, actor: 'alice', from: sent.resource, write: { to: 'in_progress' } },
          ),
        ).rejects.toBe(crash);
        const mid = (await h.parts.workflows!.read(h.tenant, ref.doc))!;
        expect(mid.state).toBe('sent');
        const raised = (await h.parts.grants.current(ref)).revision;

        // The caller repeats: no second revision. The revision is the first attempt's, and its control
        // commit is read back.
        const again = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: mid,
          write: { to: 'in_progress' },
        });
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.revision).toBe(raised);
        expect((await h.parts.grants.current(ref)).revision).toBe(raised);
        expect(again.control).not.toBeNull();
        const found = await controls(ref);
        expect(found).toHaveLength(2);
        expect(found.map((c) => c.revision)).toEqual([2, raised]);
        expect(found[1]!.steps).toEqual([]);
        expect(again.resource.state).toBe('in_progress');
        // The state and the log agree: one `in_progress` transition in the audit trail, one commit.
        const audited = (
          await h.parts.audit!.query(h.tenant, {
            doc: ref.doc,
            kind: 'workflow.transition',
            limit: 10,
          })
        ).map((e) => e.data['to']);
        expect(audited).toEqual(['sent', 'in_progress']);

        // The next transition of the same document is not mistaken for the repeat: it raises its own revision.
        const next = await recordTransition(deps(), {
          ref,
          actor: 'alice',
          from: again.resource,
          write: { to: 'voided' },
        });
        expect(next.ok).toBe(true);
        if (!next.ok) return;
        expect(next.revision).toBe(raised + 1);
        expect(await controls(ref)).toHaveLength(3);
      },
    );

    it.skipIf(skip)(
      'refuses a state that has no lock (a name that is not a state of 12)',
      async () => {
        const { ref, view } = await draft(false);
        await expect(
          recordTransition(deps(), {
            ref,
            actor: 'alice',
            from: view as WorkflowResourceView,
            write: { to: 'nonsense' },
          }),
        ).rejects.toThrow(RangeError);
      },
    );
  });
}
