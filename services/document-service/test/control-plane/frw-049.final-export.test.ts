// FRW-049 through the real service: when the last participant completes, the final export is
// queued, pinned to `completedSeq`, with the field values flattened and the certificate option as
// the workflow says; the `completed` version is stored; a failed compile leaves the workflow
// `completed`, is audited and reaches the owner. The export worker of the compile is stood in for by
// a handler (as export-jobs.test.ts does); the typesetting is EXP's. Memory storage and, when the
// test environment is up, PostgreSQL in Podman. docs/adr/0399-w4-FRW-049-final-export.md (proposed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobFailure, type JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const FIELD = 'fe00000000000001';

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
    attrs: { id: 'pFinal0000000001' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: FIELD,
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: 'Ada',
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string, certificate: boolean | undefined) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ce1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  ...(certificate === undefined ? {} : { finalisation: { certificate } }),
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the final export of a completed workflow (${storage}; FRW-049)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    let failing = false;
    const ran: Array<{
      id: string;
      seq: number;
      options: Record<string, unknown>;
      profile: string;
    }> = [];
    const handler: JobHandler = async (job, ctx) => {
      ran.push({
        id: job.id,
        seq: job.payload['seq'] as number,
        options: job.payload['options'] as Record<string, unknown>,
        profile: String(job.payload['profile']),
      });
      await ctx.report('converting', 10);
      if (failing) throw new JobFailure('compile_failed', 'The document did not compile.');
      await h.service.assets.putExport(
        job.tenant,
        job.id,
        'output.pdf',
        Buffer.from('%PDF-1.7 test'),
        'application/pdf',
      );
      return {
        output: 'output.pdf',
        pages: 1,
        layout: null,
        converged: true,
        log: null,
        diagnostics: [],
      };
    };
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        realDataPlane: true,
        jobHandlers: { export: handler },
        config: { jobIdleMs: 20, jobRetryAfterMs: 10 },
      });
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    /** Completes the only participant of a new workflow; the workflow is then `completed`. */
    async function completed(certificate: boolean | undefined, watch = false) {
      const doc = await h.createDocument({ content: document() });
      const ownerSub = `owner-049-${doc}`;
      const owner = h.userToken({ [doc]: 'owner' }, { sub: ownerSub });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc, certificate),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      expect(
        (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
      ).toBe(200);
      // The owner's channel, when the test wants to see what is pushed to it.
      let ownerChannel: DepClient | null = null;
      if (watch) {
        ownerChannel = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(ownerChannel);
        expect((await ownerChannel.hello(owner)).t).toBe('welcome');
        expect((await ownerChannel.open(1, doc)).t).toBe('ch.opened');
      }
      const tok = h.userToken({ [doc]: 'filler' }, { sub: 'sub-p1', wfp: 'p1' });
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(tok)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const done = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/complete`, {
        token: tok,
        body: {},
      });
      expect(done.status, done.text).toBe(200);
      expect(done.json.state).toBe('completed');
      const ref = { tenant: h.tenant, doc };
      const ownerActor = (await h.parts.users.resolve(h.tenant, ownerSub)).surrogate;
      return {
        doc,
        ref,
        owner,
        ownerActor,
        ownerSub,
        ownerChannel,
        completedSeq: done.json.participants[0].completedSeq,
      };
    }

    const audit = async (doc: string, kind: string) =>
      h.parts.audit!.query(h.tenant, { doc, kind, limit: 20 });
    async function settle(job: string) {
      for (let i = 0; i < 200; i++) {
        const j = await h.parts.queue.get(h.tenant, job);
        if (j && (j.state === 'completed' || j.state === 'failed')) return j;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the job did not end');
    }
    const events = (name: string, doc: string) =>
      h.events.of(`dep.workflow.${name}.v1`).filter((e) => e.subject === doc);
    const reader = (doc: string) => h.userToken({ [doc]: 'owner' }, { sub: 'owner-049-reader' });

    it.skipIf(skip)(
      'queues one export at completedSeq, flattened, with the certificate option, and stores the completed version (criteria 1, 2 and 4)',
      async () => {
        const { doc, ref, ownerActor, completedSeq } = await completed(true);
        const started = await audit(doc, 'workflow.finalisation_started');
        expect(JSON.stringify(await audit(doc, 'workflow.finalisation_failed'))).toBe('[]');
        expect(started).toHaveLength(1);
        const jobId = started[0]!.data['job'] as string;
        const job = (await h.parts.queue.get(h.tenant, jobId))!;
        expect(job).toMatchObject({ kind: 'export', doc, createdBy: ownerActor });
        // Pinned to the seq of completion; the head has moved on (the control commit of the lock).
        expect(job.payload).toMatchObject({
          seq: completedSeq,
          target: 'pdf',
          profile: 'final',
          full: true,
          options: { fields: 'flatten', certificate: true },
        });
        // The certificate facts (FRW-050): written by the service, from the evidence, at completedSeq.
        const facts = job.payload['certificate'] as {
          participants: Array<{ id: string; events: Array<{ kind: string }> }>;
        };
        expect(facts).toMatchObject({
          documentId: doc,
          completedSeq,
          networkIdentityIncluded: true,
        });
        expect((facts as unknown as { chainHeadHash: string }).chainHeadHash).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(facts.participants[0]!.id).toBe('p1');
        expect(facts.participants[0]!.events.map((e) => e.kind)).toContain('completed');
        expect((await h.parts.logs.head(ref)).seq).toBeGreaterThan(completedSeq);
        const finished = await settle(jobId);
        expect(finished.state).toBe('completed');
        expect(ran.find((r) => r.id === jobId)).toMatchObject({
          seq: completedSeq,
          options: { fields: 'flatten', certificate: true },
          profile: 'final',
        });
        // The `completed` version names the document at completedSeq.
        const versions = await h.parts.versions!.list(ref, { kind: 'completed' });
        expect(versions.map((v) => v.seq)).toEqual([completedSeq]);
        // `completed` is raised once; `finalised` is the seal's and is not raised by the export.
        expect(events('completed', doc)).toHaveLength(1);
        expect(events('finalised', doc)).toHaveLength(0);
        expect(
          (await h.call('GET', `/v1/documents/${doc}/workflow`, { token: reader(doc) })).json.state,
        ).toBe('completed');
        // A repeated completion starts no second job.
        expect(await audit(doc, 'workflow.finalisation_started')).toHaveLength(1);
      },
      60_000,
    );

    it.skipIf(skip)(
      'asks for no certificate pages when finalisation.certificate is false or absent (criterion 5)',
      async () => {
        for (const option of [false, undefined]) {
          const { doc, completedSeq } = await completed(option);
          const [entry] = await audit(doc, 'workflow.finalisation_started');
          const job = (await h.parts.queue.get(h.tenant, entry!.data['job'] as string))!;
          expect(job.payload).toMatchObject({
            seq: completedSeq,
            options: { fields: 'flatten', certificate: false },
          });
          // No certificate: the job carries no facts for one.
          expect(job.payload['certificate']).toBeUndefined();
          expect((await settle(job.id)).state).toBe('completed');
        }
      },
      60_000,
    );

    it.skipIf(skip)(
      'leaves the workflow completed when the compile fails, audits it, tells the owner and the host, and raises no finalised (criteria 3 and 4)',
      async () => {
        failing = true;
        try {
          const { doc, ownerActor, ownerChannel, ownerSub } = await completed(true, true);
          const [entry] = await audit(doc, 'workflow.finalisation_started');
          const jobId = entry!.data['job'] as string;
          const job = await settle(jobId);
          expect(job.state).toBe('failed');
          expect(job.error).toMatchObject({ code: 'compile_failed' });
          // The operator: the audit trail. The host: the webhook.
          for (
            let i = 0;
            i < 100 && (await audit(doc, 'workflow.finalisation_failed')).length === 0;
            i++
          )
            await new Promise((r) => setTimeout(r, 25));
          const failed = await audit(doc, 'workflow.finalisation_failed');
          expect(failed).toHaveLength(1);
          expect(failed[0]!.data).toMatchObject({
            job: jobId,
            code: 'compile_failed',
            stage: 'export',
          });
          expect(h.events.of('dep.export.failed.v1').filter((e) => e.subject === doc)).toHaveLength(
            1,
          );
          // The owner: `export.failed` on their channel, and the job with its error.
          const told = await ownerChannel!.take(
            (m) => JSON.stringify(m).includes('export.failed'),
            5000,
            'export.failed',
          );
          expect(JSON.stringify(told)).toContain(jobId);
          expect(job.createdBy).toBe(ownerActor);
          // The owner reads the failed job: its state and its error code.
          const read = await h.call('GET', `/v1/exports/${jobId}`, {
            token: h.userToken({ [doc]: 'owner' }, { sub: ownerSub }),
          });
          expect(read.status, read.text).toBe(200);
          expect(read.json).toMatchObject({ state: 'failed', error: { code: 'compile_failed' } });
          // The workflow is still `completed`, not `finalised`; `finalised` is not raised.
          const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: reader(doc) });
          expect(w.json.state).toBe('completed');
          expect(events('finalised', doc)).toHaveLength(0);
          expect(events('completed', doc)).toHaveLength(1);
        } finally {
          failing = false;
        }
      },
      60_000,
    );
  });
}
