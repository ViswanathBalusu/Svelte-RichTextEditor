// FRW-031 criteria 2 and 5 through the participants' own channels (FRW-038 tokens): when the
// participants of the lowest incomplete order have completed, the next order is activated together,
// `participant_activated` is raised for each and each of them receives `wf.changed` with its own
// status and `perm.changed` with `fill.active` true; an approver completes by approving, with no field
// to fill; a participant of kind `cc` is never active, its fill is refused, it is not waited for, and
// it reads the sealed result once the workflow is finalised. The real token service and data plane,
// real WebSocket clients, memory storage and, when the test environment is up, PostgreSQL in Podman.
// docs/adr/0384-w4-FRW-031-progression.md (proposed).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finaliseSealed } from '../../src/workflow/finalise-sealed.ts';
import { MemorySealedPdfStore } from '../../src/workflow/sealed-store.ts';
import { DepClient } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const FIELD = 'ffTenant00000031';
const PDF = new TextEncoder().encode('%PDF-1.7 sealed test bytes');

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
    attrs: { id: 'pTenant000000031' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: FIELD,
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: false,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c31',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['tenant'], kind: 'filler', order: 2, sub: 'sub-p2' },
    { id: 'ap', roles: ['landlord'], kind: 'approver', order: 2, sub: 'sub-ap' },
    // The copy is at order 2 too, so that its turn comes when the others' does.
    { id: 'cc', roles: ['tenant'], kind: 'cc', order: 2, sub: 'sub-cc' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`activation of the next order on the participants' channels (${storage}; FRW-031)`, async () => {
    const skip = await skipReason(storage);
    const sealed = new MemorySealedPdfStore();
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, { realDataPlane: true, parts: { sealedPdfs: sealed } });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const tokenOf = (doc: string, pid: string) =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });
    const tree = () => schema.nodeFromJSON((document() as { doc: unknown }).doc);

    async function connect(doc: string, pid: string) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(tokenOf(doc, pid))).t).toBe('welcome');
      const o = await c.open(1, doc);
      expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
      const d = o.d as {
        access: { fill: { active: boolean } | null };
        workflow: { state: string; participant?: { state: string } };
      };
      const word = (w: { state: string; participant?: { state: string } }) =>
        `${w.state}/${w.participant?.state ?? '-'}`;
      return {
        c,
        fill: d.access.fill,
        /** The workflow object the channel opened with, as the later `wf.changed` are written. */
        initial: word(d.workflow),
      };
    }

    /**
     * The workflow object a channel holds, as `state/own status`: the one it opened with, then each
     * `wf.changed` (a complete object, sent when it differs).
     */
    const seen = (p: { c: DepClient; initial: string }) => [
      p.initial,
      ...p.c.all('wf.changed', 1).map((m) => {
        const d = m.d as { state: string; participant?: { id: string; state: string } };
        return `${d.state}/${d.participant?.state ?? '-'}`;
      }),
    ];
    const until = async (what: string, ok: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await ok()) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    it.skipIf(skip)(
      'activates the next order together, tells each participant, and never activates a cc; the approver approves with no field; the cc reads the result (criteria 2 and 5)',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-031-${doc}` });
        const ref = { tenant: h.tenant, doc };
        expect(
          (
            await h.call('PUT', `/v1/documents/${doc}/workflow`, {
              token: owner,
              body: BODY(doc),
              headers: { 'if-match': '"0"' },
            })
          ).status,
        ).toBe(201);
        expect(
          (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
        ).toBe(200);

        // Everybody opens the document: only order 1 is active, and a cc is never.
        const p1 = await connect(doc, 'p1');
        const p2 = await connect(doc, 'p2');
        const ap = await connect(doc, 'ap');
        const cc = await connect(doc, 'cc');
        expect(p1.fill).toMatchObject({ active: true });
        for (const waiting of [p2, ap, cc]) expect(waiting.fill).toMatchObject({ active: false });
        let views: unknown = null;
        await until('every first view', async () => {
          const row = await h.parts.workflows!.read(h.tenant, doc);
          views = row!.participants.map((p) => [p.id, p.state, p.firstViewedAt]);
          return row!.participants.every((p) => p.firstViewedAt !== undefined);
        }).catch((e: Error) => {
          throw new Error(`${e.message}: ${JSON.stringify(views)}`);
        });
        expect(seen(cc).at(-1)).toBe('in_progress/copy');
        expect(seen(p2).at(-1)).toBe('in_progress/waiting');

        // The completion of the only order 1 participant activates order 2: each of them is told,
        // with its own status, and the event is raised for each of them and for no copy.
        const done = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/complete`,
          {
            token: tokenOf(doc, 'p1'),
            body: {},
          },
        );
        expect(done.status, done.text).toBe(200);
        await until('wf.changed to the activated', () =>
          [p2, ap].every((p) => seen(p).at(-1) === 'in_progress/active'),
        );
        for (const active of [p2, ap]) {
          const access = await active.c.take(
            (m) => m.t === 'perm.changed' && m.ch === 1 && m.d?.fill?.active === true,
            5000,
            'perm.changed with fill.active',
          );
          expect(access.d?.fill).toMatchObject({ active: true });
        }
        const activated = h.events
          .of('dep.workflow.participant_activated.v1')
          .filter((e) => e.subject === doc)
          .map((e) => (e.data as { participant: string }).participant)
          .sort();
        expect(activated).toEqual(['ap', 'p1', 'p2']);
        // The cc is told nothing that makes it active, and its fill is refused.
        expect(seen(cc).at(-1)).toBe('in_progress/copy');
        const refused = await cc.c.submit(1, {
          base: (await h.parts.logs.head(ref)).seq,
          steps: [{ stepType: 'attr', pos: posOf(tree(), FIELD), attr: 'value', value: 'Cy' }],
        });
        expect(refused.t).toBe('sync.reject');
        expect(
          (
            await h.call('POST', `/v1/documents/${doc}/workflow/participants/cc/complete`, {
              token: tokenOf(doc, 'cc'),
              body: {},
            })
          ).status,
        ).toBeGreaterThanOrEqual(400);

        // The approver approves: completing with nothing to fill. The last participant who must act
        // completes, and the workflow is `completed` with the cc never asked.
        const approved = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/ap/complete`,
          { token: tokenOf(doc, 'ap'), body: {} },
        );
        expect(approved.status, approved.text).toBe(200);
        expect(approved.json.state).toBe('in_progress');
        const last = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p2/complete`,
          {
            token: tokenOf(doc, 'p2'),
            body: {},
          },
        );
        expect(last.status, last.text).toBe(200);
        expect(last.json.state).toBe('completed');
        await until('wf.changed completed to the copy', () => seen(cc).at(-1) === 'completed/copy');

        // The copy receives the result: the sealed PDF, once the workflow is finalised.
        const before = await h.call('GET', `/v1/documents/${doc}/workflow/final`, {
          token: tokenOf(doc, 'cc'),
        });
        expect(before.status).toBe(404);
        const out = await finaliseSealed(
          {
            workflows: h.parts.workflows!,
            grants: h.parts.grants,
            logs: h.parts.logs,
            notifier: h.service.dataPlane,
            audit: h.parts.audit,
            now: h.now,
            controlWaitMs: 5000,
            sealed,
          },
          {
            ref,
            actor: 'system',
            bytes: PDF,
            sealedHash: createHash('sha256').update(PDF).digest('hex'),
            timestamped: true,
            retainUntilMs: Date.UTC(2040, 0, 1),
          },
        );
        expect(out.ok).toBe(true);
        const result = await h.call('GET', `/v1/documents/${doc}/workflow/final`, {
          token: tokenOf(doc, 'cc'),
        });
        expect(result.status, result.text).toBe(200);
        expect(result.headers.get('content-type')).toContain('application/pdf');
      },
      90_000,
    );
  });
}
