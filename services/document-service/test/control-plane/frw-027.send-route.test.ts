// FRW-027: `POST /documents/{id}/workflow/send` over HTTP against the real data plane, on memory
// storage and, when the test environment is up, on PostgreSQL in Podman (infra/test-env.ps1). The
// decisions are in docs/adr/0383-w4-FRW-027-send-route.md and docs/adr/0382-w4-FRW-030-transition-record.md
// (both proposed). The control commit is written by the room, so an owner is connected to it.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { until } from '../data-plane/support.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const fid = (n: number) => `ff${String(n).padStart(14, '0')}`;

interface Variant {
  /** The `assignee` of the required field. */
  assignee: string | null;
  /** A role that has no participant. */
  orphanRole?: boolean;
  /** An unresolved suggestion in the text. */
  suggestion?: boolean;
  /** A rule that reads a field that does not exist. */
  badRule?: boolean;
}

/** The regions fixture with a required field, two roles and the variant's faults. */
function document(v: Variant): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  if (v.orphanRole)
    defs.push({ type: 'role_def', attrs: { id: 'witness', name: 'Witness', color: '#2CA02C' } });
  if (v.badRule)
    defs.push({
      type: 'rule_def',
      attrs: {
        id: 'ruleBad000000001',
        when: { '==': [{ field: 'no.such.field' }, 'x'] },
        then: [{ hide: ['also.missing'] }],
      },
    });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000003' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: fid(1),
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: v.assignee,
          required: true,
          value: null,
        },
      },
      { type: 'text', text: ' ' },
      {
        type: 'form_field',
        attrs: {
          id: fid(2),
          key: 'landlord.name',
          kind: 'text',
          label: 'Landlord',
          assignee: 'landlord',
          value: null,
        },
      },
      ...(v.suggestion
        ? [
            {
              type: 'text',
              text: ' proposed',
              marks: [{ type: 'ins', attrs: { id: 'sSug000000000001', user: 'dave' } }],
            },
          ]
        : []),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1 },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2 },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`send for completion (${storage}; FRW-027)`, async () => {
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

    /** A document with its draft workflow; `connect` opens the owner's room. */
    async function draft(v: Variant, connect = false) {
      const doc = await h.createDocument({ content: document(v) });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-027-${uuid7()}` });
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
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }
    const send = (doc: string, token: string, key?: string) =>
      h.call('POST', `/v1/documents/${doc}/workflow/send`, {
        token,
        ...(key ? { headers: { 'idempotency-key': key } } : {}),
      });
    const state = async (doc: string, token: string) =>
      (await h.call('GET', `/v1/documents/${doc}/workflow`, { token })).json.state;

    it.skipIf(skip)(
      'refuses a caller without manage as forbidden and changes nothing (criterion 6)',
      async () => {
        const { doc, owner, ref } = await draft({ assignee: 'tenant' });
        const editor = h.userToken({ [doc]: 'editor' }, { sub: `editor-027-${uuid7()}` });
        const r = await send(doc, editor);
        expect(r.status, r.text).toBe(403);
        expect(r.json.code).toBe('forbidden');
        expect(await state(doc, owner)).toBe('draft');
        expect((await h.parts.grants.current(ref)).workflowActive).toBe(false);
      },
    );

    it.skipIf(skip)(
      'lists every failure of the check by field key, role and suggestion, and the state stays draft (criteria 1 and 2)',
      async () => {
        const { doc, owner, ref } = await draft({
          assignee: null,
          orphanRole: true,
          suggestion: true,
          badRule: true,
        });
        const r = await send(doc, owner);
        expect(r.status, r.text).toBe(400);
        expect(r.json.code).toBe('validation_failed');
        const paths = (r.json.violations as Array<{ path: string }>).map((v) => v.path);
        expect(paths).toContain('/fields/tenant.name');
        expect(paths).toContain('/roles/witness');
        expect(paths).toContain('/suggestions/sSug000000000001');
        expect(
          paths.some(
            (p) =>
              !p.startsWith('/fields/') &&
              !p.startsWith('/roles/') &&
              !p.startsWith('/suggestions/'),
          ),
        ).toBe(true);
        expect(await state(doc, owner)).toBe('draft');
        expect((await h.parts.grants.current(ref)).documentState).toBe('active');
        expect((await h.parts.logs.read(ref)).filter((c) => c.kind === 'control')).toHaveLength(0);
        expect(h.events.of('dep.workflow.sent.v1').filter((e) => e.subject === doc)).toHaveLength(
          0,
        );
      },
    );

    it.skipIf(skip)(
      'answers an unresolved suggestion alone with the pending_suggestions code of the registry',
      async () => {
        const { doc, owner } = await draft({ assignee: 'tenant', suggestion: true });
        const r = await send(doc, owner);
        expect(r.status, r.text).toBe(409);
        expect(r.json.code).toBe('pending_suggestions');
        expect(r.json.violations).toEqual([
          { path: '/suggestions/sSug000000000001', rule: 'no suggestion is unresolved' },
        ]);
      },
    );

    it.skipIf(skip)(
      'sends: records sentSeq and the chain hash, locks, activates the lowest order, stores the sent version and raises the webhooks, once for a repeated key (criteria 3, 4 and 5)',
      async () => {
        const { doc, owner, ref } = await draft({ assignee: 'tenant' }, true);
        const headBefore = (await h.parts.logs.head(ref)).seq;
        const key = `send-${uuid7()}`;
        const r = await send(doc, owner, key);
        expect(r.status, r.text).toBe(200);
        expect(r.json.state).toBe('sent');
        expect(r.json.sentSeq).toBe(headBefore);
        expect(r.json.sentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        const parts = r.json.participants as Array<{ id: string; state: string }>;
        expect(parts.map((p) => [p.id, p.state])).toEqual([
          ['p1', 'active'],
          ['p2', 'pending'],
        ]);

        // The document is locked and a workflow runs.
        const perms = await h.parts.grants.current(ref);
        expect(perms.documentState).toBe('locked');
        expect(perms.workflowActive).toBe(true);
        // One control commit, after sentSeq.
        const controls = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');
        expect(controls).toHaveLength(1);
        expect(controls[0]!.seq).toBe(headBefore + 1);
        // The sent version at sentSeq.
        const versions = await h.parts.versions!.list(ref, { kind: 'sent' });
        expect(versions.map((v) => v.seq)).toEqual([headBefore]);
        // The webhooks: sent, and one participant_activated for the one participant activated.
        const sent = h.events.of('dep.workflow.sent.v1').filter((e) => e.subject === doc);
        const activated = h.events
          .of('dep.workflow.participant_activated.v1')
          .filter((e) => e.subject === doc);
        expect(sent).toHaveLength(1);
        expect(activated).toHaveLength(1);
        expect(activated[0]!.data['participant']).toBe('p1');
        expect(sent[0]!.data['seq']).toBe(controls[0]!.seq);
        expect(sent[0]!.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
        expect(sent[0]!.data['document']).toBe(doc);
        expect(sent[0]!.data['workflow']).toBe(r.json.id);

        // The same request again is answered from the stored response: sent once.
        const again = await send(doc, owner, key);
        expect(again.status).toBe(200);
        expect(again.json).toEqual(r.json);
        expect(h.events.of('dep.workflow.sent.v1').filter((e) => e.subject === doc)).toHaveLength(
          1,
        );
        expect((await h.parts.logs.read(ref)).filter((c) => c.kind === 'control')).toHaveLength(1);

        // A send when the state is not draft is refused and nothing changes.
        const second = await send(doc, owner, `other-${uuid7()}`);
        expect(second.status, second.text).toBe(409);
        expect(second.json.code).toBe('conflict');
        expect(await state(doc, owner)).toBe('sent');
        expect(h.events.of('dep.workflow.sent.v1').filter((e) => e.subject === doc)).toHaveLength(
          1,
        );
        expect((await h.parts.versions!.list(ref, { kind: 'sent' })).length).toBe(1);
      },
    );

    it.skipIf(skip)(
      'sends wf.changed to each connected client, a participant with their own status only (criterion 4)',
      async () => {
        const doc = await h.createDocument({ content: document({ assignee: 'tenant' }) });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-027-${uuid7()}` });
        const body = {
          ...BODY(doc),
          participants: [
            { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-027-p1' },
            { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-027-p2' },
          ],
        };
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body,
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);

        const open = async (token: string): Promise<DepClient> => {
          const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
          clients.push(c);
          expect((await c.hello(token)).t).toBe('welcome');
          expect((await c.open(1, doc)).t).toBe('ch.opened');
          return c;
        };
        const participantToken = (pid: string) =>
          h.userToken({ [doc]: 'filler' }, { sub: `sub-027-${pid}`, wfp: pid });
        const watcher = await open(owner);
        const first = await open(participantToken('p1'));
        const second = await open(participantToken('p2'));
        const pushes = (c: DepClient) =>
          c
            .all('wf.changed', 1)
            .map((m) => m.d as { state: string; participant?: { id: string; state: string } });

        const r = await send(doc, owner);
        expect(r.status, r.text).toBe(200);

        for (const c of [watcher, first, second])
          await until(() => pushes(c).some((p) => p.state === 'sent'), 5000, 'wf.changed');
        // The owner is no participant: the state alone.
        expect(pushes(watcher).at(-1)!.participant).toBeUndefined();
        // A participant gets their own status and nobody else's.
        expect(pushes(first).at(-1)!.participant).toEqual({ id: 'p1', state: 'active' });
        expect(pushes(second).at(-1)!.participant).toEqual({ id: 'p2', state: 'waiting' });
        expect(JSON.stringify(pushes(first))).not.toContain('p2');
        expect(JSON.stringify(pushes(second))).not.toContain('p1');
      },
      60_000,
    );
  });
}
