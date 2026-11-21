// FRW-054 criteria 2, 4 and 5 through the real service: the sealed bytes of a completed workflow are
// stored write-once, the workflow moves to `finalised` with a control commit and an audit entry and
// `finalised` is raised; a failed store, a seal without a time-stamp and bytes that do not match the
// sealed hash leave it `completed`; `GET /documents/{id}/workflow/final` returns the sealed PDF and
// its hash; nothing rewrites the stored bytes. The signing service is not built (FRW-052, FRW-053),
// so the sealed bytes are test bytes handed to `finaliseSealed`. Memory storage and, when the test
// environment is up, PostgreSQL in Podman (the sealed store is the memory one in both: the object
// store and its table have their own tests, frw-054.v-ux-031-045.store-and-record.pg.test.ts).
// docs/adr/0401-w4-FRW-054-finalise-and-final-route.md (proposed).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finaliseSealed } from '../../src/workflow/finalise-sealed.ts';
import { raiseWorkflowEvents } from '../../src/workflow/raise-events.ts';
import { MemorySealedPdfStore, type SealedPdfStore } from '../../src/workflow/sealed-store.ts';
import type { TransitionDeps } from '../../src/workflow/transitions.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const FIELD = 'ff00000000000054';

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
    attrs: { id: 'pFinal0000000054' },
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

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c54',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

const PDF = new TextEncoder().encode('%PDF-1.7 sealed test bytes');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const RETAIN = Date.UTC(2040, 0, 1);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`finalising a sealed workflow (${storage}; FRW-054)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const sealed = new MemorySealedPdfStore();
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        realDataPlane: true,
        parts: { sealedPdfs: sealed },
        jobHandlers: {
          export: async (_job, ctx) => {
            await ctx.report('converting', 10);
            return {
              output: 'output.pdf',
              pages: 1,
              layout: null,
              converged: true,
              log: null,
              diagnostics: [],
            };
          },
        },
        config: { jobIdleMs: 20, jobRetryAfterMs: 10 },
      });
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const deps = (store: SealedPdfStore = sealed): TransitionDeps & { sealed: SealedPdfStore } => ({
      workflows: h.parts.workflows!,
      grants: h.parts.grants,
      logs: h.parts.logs,
      notifier: h.service.dataPlane,
      audit: h.parts.audit,
      now: h.now,
      controlWaitMs: 5000,
      sealed: store,
    });

    /** A workflow whose only participant has completed, so that it is `completed`. */
    async function completed() {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-054-${doc}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: body(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      expect(
        (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
      ).toBe(200);
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
      return { doc, owner, ref: { tenant: h.tenant, doc }, workflowId: done.json.id as string };
    }

    const controls = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control').length;
    const state = async (ref: { tenant: string; doc: string }) =>
      (await h.parts.workflows!.read(ref.tenant, ref.doc))!.state;
    const request = (
      ref: { tenant: string; doc: string },
      extra: Record<string, unknown> = {},
    ) => ({
      ref,
      actor: 'system',
      bytes: PDF,
      sealedHash: sha256(PDF),
      timestamped: true,
      retainUntilMs: RETAIN,
      ...extra,
    });

    it.skipIf(skip !== null)(
      'moves a completed workflow to finalised with a control commit, an audit entry and the event (criterion 2)',
      async () => {
        const w = await completed();
        const before = await controls(w.ref);
        const out = await finaliseSealed(deps(), request(w.ref));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.gate).toMatchObject({ status: 'finalised', alert: false });
        expect(out.resource.state).toBe('finalised');
        expect(await state(w.ref)).toBe('finalised');
        // The control commit of the transition is in the log, once, and the outcome names it.
        expect(await controls(w.ref)).toBe(before + 1);
        expect(out.control).not.toBeNull();
        const log = await h.parts.logs.read(w.ref);
        expect(log.some((c) => c.kind === 'control' && c.seq === out.control!.seq)).toBe(true);
        // The audit trail has the transition with the hash of the sealed bytes.
        const entries = await h.parts.audit!.query(h.tenant, {
          doc: w.doc,
          kind: 'workflow.transition',
          limit: 20,
        });
        const entry = entries.find((e) => (e.data as { to?: string }).to === 'finalised');
        expect(entry?.data).toMatchObject({
          from: 'completed',
          to: 'finalised',
          sealedHash: sha256(PDF),
        });
        // `finalised` is raised, with the seq of the control commit and the chain head.
        expect(out.raised).toEqual([{ name: 'finalised' }]);
        await raiseWorkflowEvents(
          { logs: h.parts.logs, now: h.now, events: h.events },
          w.ref,
          out.resource,
          out.control,
          out.raised,
        );
        const events = h.events.of('dep.workflow.finalised.v1').filter((e) => e.subject === w.doc);
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toMatchObject({ seq: out.control!.seq, workflow: w.workflowId });
        // The finalised document stays locked and nobody fills it.
        const perms = await h.parts.grants.current(w.ref);
        expect(perms).toMatchObject({ documentState: 'locked', workflowActive: false });
        // A finalised workflow is not finalised again.
        expect(await finaliseSealed(deps(), request(w.ref))).toEqual({
          ok: false,
          problem: { code: 'invalid_state', state: 'finalised' },
        });
      },
    );

    it.skipIf(skip !== null)(
      'leaves the workflow completed when the store fails, and raises nothing (criterion 2)',
      async () => {
        const w = await completed();
        const before = await controls(w.ref);
        const failing: SealedPdfStore = {
          store: () =>
            Promise.resolve({ store: { ok: false, reason: 'store_failed' }, record: null }),
          read: () => Promise.resolve(null),
          readLatest: () => Promise.resolve(null),
          storeUpdate: () => Promise.resolve({ ok: false, reason: 'not_sealed' }),
        };
        const out = await finaliseSealed(deps(failing), request(w.ref));
        expect(out).toMatchObject({
          ok: true,
          raised: [],
          control: null,
          gate: { status: 'completed', alert: true, failure: { code: 'store_failed' } },
        });
        expect(await state(w.ref)).toBe('completed');
        expect(await controls(w.ref)).toBe(before);
        // The same bytes can be sealed and stored once the store works again.
        const again = await finaliseSealed(deps(), request(w.ref));
        expect(again).toMatchObject({ ok: true, gate: { status: 'finalised' } });
        expect(await state(w.ref)).toBe('finalised');
      },
    );

    it.skipIf(skip !== null)(
      'stores nothing for a seal without a time-stamp, and nothing for bytes that are not the sealed ones',
      async () => {
        const w = await completed();
        const noStamp = await finaliseSealed(deps(), request(w.ref, { timestamped: false }));
        expect(noStamp).toMatchObject({
          ok: true,
          gate: { status: 'completed', alert: true, failure: { code: 'no_timestamp' } },
        });
        expect(await sealed.read(w.ref.tenant, w.doc, w.workflowId)).toBeNull();
        const other = await finaliseSealed(
          deps(),
          request(w.ref, { sealedHash: sha256(new TextEncoder().encode('other')) }),
        );
        expect(other).toMatchObject({
          ok: true,
          gate: { status: 'completed', alert: true, failure: { code: 'stored_hash_differs' } },
        });
        expect(await state(w.ref)).toBe('completed');
        expect(
          (await h.call('GET', `/v1/documents/${w.doc}/workflow/final`, { token: w.owner })).status,
        ).toBe(404);
      },
    );

    it.skipIf(skip !== null)(
      'answers the sealed PDF and its hash to an authorised caller, and nothing before finalisation (criterion 4)',
      async () => {
        const w = await completed();
        const path = `/v1/documents/${w.doc}/workflow/final`;
        expect((await h.call('GET', path, { token: w.owner })).status).toBe(404);
        const out = await finaliseSealed(deps(), request(w.ref));
        expect(out.ok).toBe(true);
        const res = await fetch(`${h.base}${path}`, {
          headers: { authorization: `Bearer ${w.owner}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
        expect(res.headers.get('etag')).toBe(`"sha256:${sha256(PDF)}"`);
        expect(res.headers.get('repr-digest')).toBe(
          `sha-256=:${Buffer.from(sha256(PDF), 'hex').toString('base64')}:`,
        );
        const cached = await fetch(`${h.base}${path}`, {
          headers: {
            authorization: `Bearer ${w.owner}`,
            'if-none-match': `"sha256:${sha256(PDF)}"`,
          },
        });
        expect(cached.status).toBe(304);
        // A caller with no access to the document gets nothing.
        const elsewhere = await h.createDocument({ content: document() });
        const stranger = h.userToken({ [elsewhere]: 'owner' }, { sub: 'stranger-054' });
        expect([403, 404]).toContain((await h.call('GET', path, { token: stranger })).status);
      },
    );

    it.skipIf(skip !== null)(
      'offers no operation that rewrites the stored PDF (criterion 5)',
      async () => {
        const w = await completed();
        const out = await finaliseSealed(deps(), request(w.ref));
        expect(out.ok).toBe(true);
        const path = `/v1/documents/${w.doc}/workflow/final`;
        for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
          const r = await h.call(method, path, { token: w.owner, body: {} });
          expect([404, 405], `${method} ${r.status}`).toContain(r.status);
        }
        // The store itself refuses a second write for the workflow, with other bytes too.
        const other = new TextEncoder().encode('%PDF-1.7 other');
        const second = await sealed.store({
          tenant: w.ref.tenant,
          docId: w.doc,
          workflowId: w.workflowId,
          bytes: other,
          sealedHash: sha256(other),
          retainUntilMs: RETAIN,
        });
        expect(second.store).toEqual({ ok: false, reason: 'store_failed' });
        const kept = await sealed.read(w.ref.tenant, w.doc, w.workflowId);
        expect(kept?.bytes).toEqual(PDF);
        expect(kept?.record.storedHash).toBe(sha256(PDF));
      },
    );
  });
}
