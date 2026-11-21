// FRW-038 through the real service: a host-minted token with the document role `filler`, an opaque
// `sub` and `wfp` fills as the participant it binds to, and only then; `amr` and `auth_time` are
// recorded as given and never vouched for; the service offers no passcode or identity check; a
// refreshed token recomputes access; and a participant of a declined, voided or expired workflow
// has no fill capability while the token is still valid. The real data plane, a real WebSocket
// client, memory storage and, when the test environment is up, PostgreSQL in Podman.
// docs/adr/0390-w4-FRW-038-participant-tokens.md (proposed).
import { uuid7 } from '@docedit/model';
import { definition } from '@docedit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DepDataPlaneInstance } from '../../src/data-plane/index.ts';
import type { Session } from '../../src/data-plane/session.ts';
import { DepClient } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import { sweepTenant } from '../../src/workflow/schedule-sweep.ts';
import { openAndSettle } from './first-view.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TENANT_FIELD = 'ffTenant00000001';
const HOUR = 3_600_000;

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

const BODY = (doc: string, extra: Record<string, unknown> = {}) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
    { id: 'zz', roles: ['tenant'], kind: 'filler', order: 3, sub: 'sub-zz' },
  ],
  ...extra,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`participant tokens (${storage}; FRW-038)`, async () => {
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

    const tree = () => schema.nodeFromJSON((document() as { doc: unknown }).doc);
    const set = (value: string) => ({
      stepType: 'attr',
      pos: posOf(tree(), TENANT_FIELD),
      attr: 'value',
      value,
    });

    /** A document with a workflow, sent (or left as a draft). */
    async function workflow(send = true, extra: Record<string, unknown> = {}) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-038-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, extra),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      if (send) {
        const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(r.status, r.text).toBe(200);
      }
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    /** A token as a host mints it for a person outside its users: one document, `filler`. */
    const tokenFor = (doc: string, sub: string, claims: Record<string, unknown> = {}) =>
      h.userToken({ [doc]: 'filler' }, { sub, ...claims });

    async function connect(token: string): Promise<DepClient> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      const w = await c.hello(token);
      expect(w.t, JSON.stringify(w.d)).toBe('welcome');
      return c;
    }

    async function open(c: DepClient, doc: string, ch = 1) {
      // A bound participant's first view is recorded after the channel opens (FRW-040): wait until
      // the room has it, so that its transition does not interleave with what the test does next.
      const o = await openAndSettle(h, c, doc, ch);
      expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
      return (o.d as { access: { fill: { participant?: string } | null } }).access.fill;
    }

    const base = async (ref: { tenant: string; doc: string }) => (await h.parts.logs.head(ref)).seq;
    const post = (path: string, token: string, body?: unknown) =>
      h.call('POST', path, { token, ...(body !== undefined ? { body } : {}) });

    it.skipIf(skip)(
      'gives access.fill the participant and the roles of that participant in the workflow, and lets them fill (criterion 1)',
      async () => {
        const { doc, ref } = await workflow();
        // The token carries no fill roles of its own: nothing but `wfp` and the `sub`.
        const c = await connect(tokenFor(doc, 'sub-p1', { wfp: 'p1' }));
        expect(await open(c, doc)).toEqual({ participant: 'p1', roles: ['tenant'], active: true });
        const ack = await c.submit(1, { base: await base(ref), steps: [set('Ada')] });
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');

        // The second participant is bound too, with its own roles, and waits for its turn.
        const waiting = await connect(tokenFor(doc, 'sub-p2', { wfp: 'p2' }));
        expect(await open(waiting, doc)).toEqual({
          participant: 'p2',
          roles: ['landlord'],
          active: false,
        });
        const refused = await waiting.submit(1, { base: await base(ref), steps: [set('Bea')] });
        expect(refused.t).toBe('sync.reject');
      },
    );

    it.skipIf(skip)(
      'gives no fill to a token whose wfp names another workflow’s participant or whose sub differs, whatever else it claims (criterion 2)',
      async () => {
        const mine = await workflow();
        const other = await workflow(true);
        // lsewhere is a participant id that is not in this document's workflow.
        const cases: Array<[string, Record<string, unknown>, string]> = [
          ['a wfp that names no participant of this workflow', { wfp: 'elsewhere' }, 'sub-p1'],
          ['a sub that differs from the participant’s', { wfp: 'p1' }, 'sub-someone-else'],
          [
            'the fill roles claim of the form mode beside an unbound wfp',
            { wfp: 'p1', wfr: ['tenant'] },
            'sub-someone-else',
          ],
        ];
        for (const [name, claims, sub] of cases) {
          const c = await connect(tokenFor(mine.doc, sub, claims));
          expect(await open(c, mine.doc), name).toBeNull();
          const r = await c.submit(1, { base: await base(mine.ref), steps: [set('Mal')] });
          expect(r.t, name).toBe('sync.reject');
        }
        // A token for the other document binds there, and only there: its token names `p1` of the
        // other workflow, and opening this document with it gives nothing (a token has one document
        // here, so the connection is refused, which is also no fill).
        const crossed = await connect(tokenFor(other.doc, 'sub-p1', { wfp: 'p1' }));
        expect(await open(crossed, other.doc)).toMatchObject({ participant: 'p1' });
        const into = await crossed.open(2, mine.doc);
        expect(into.t).toBe('ch.rejected');
        // The same for a person who is no participant of a workflow that was never sent.
        const draft = await workflow(false);
        const early = await connect(tokenFor(draft.doc, 'sub-p1', { wfp: 'p1' }));
        expect(await open(early, draft.doc)).toBeNull();
      },
    );

    it.skipIf(skip)(
      'records amr and auth_time exactly as given, accepts values it could not verify, and presents them nowhere (criterion 3)',
      async () => {
        const { doc, owner } = await workflow();
        const sub = 'sub-p1';
        // Values no real authentication would give: the service neither checks nor refuses them.
        const claims = {
          wfp: 'p1',
          amr: ['made-up-method', 'pwd', ''],
          auth_time: 4_102_444_800,
        };
        const c = await connect(tokenFor(doc, sub, claims));
        const fill = await open(c, doc);
        expect(fill).toMatchObject({ participant: 'p1' });
        const plane = h.service.dataPlane as unknown as DepDataPlaneInstance;
        const session = plane.sessions.filter(
          (s: Session) => s.identity?.sub === sub && s.assertedClaims(1) !== undefined,
        );
        const recorded = session.map((s) => s.assertedClaims(1)).at(-1);
        expect(recorded?.claims).toEqual(claims);
        // Nothing sent back carries them, and no response of the workflow resource presents them.
        for (const frame of c.frames) {
          expect(frame).not.toContain('made-up-method');
          expect(frame).not.toContain('4102444800');
        }
        const read = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        expect(read.status, read.text).toBe(200);
        expect(read.text).not.toContain('made-up-method');
        expect(read.text).not.toMatch(/verified/i);
      },
    );

    it.skipIf(skip)(
      'offers no one-time passcode and no identity-verification endpoint (criterion 4)',
      async () => {
        const { doc, owner } = await workflow();
        // The operations the service publishes: none is a passcode or an identity check. The only
        // `verify` is the participant's access-code check of FRW-039, which holds a code the host
        // registered and issues nothing.
        const operations = definition.DEP1.operations;
        const names = operations.map((o) => `${o.operationId} ${o.path}`.toLowerCase());
        expect(names.length).toBeGreaterThan(50);
        for (const n of names) expect(n).not.toMatch(/otp|passcode|one-time|identity|kyc|sms/);
        const verifying = operations.filter((o) => /verif/i.test(`${o.operationId} ${o.path}`));
        expect(verifying.map((o) => o.operationId)).toEqual(['participantVerify']);
        // And nothing answers at the paths such a service would use.
        for (const path of [
          `/v1/documents/${doc}/workflow/participants/p1/otp`,
          `/v1/documents/${doc}/workflow/participants/p1/passcode`,
          `/v1/documents/${doc}/workflow/participants/p1/identity`,
          `/v1/documents/${doc}/workflow/identity`,
          `/v1/identity/verify`,
          `/v1/otp`,
        ]) {
          for (const method of ['GET', 'POST']) {
            const r = await h.call(method, path, { token: owner });
            expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
            expect([403, 404, 405], `${method} ${path} ${r.text}`).toContain(r.status);
          }
        }
      },
    );

    it.skipIf(skip)(
      'recomputes access and sends perm.changed when a refreshed token’s wfp differs (criterion 5)',
      async () => {
        const { doc, ref } = await workflow();
        const sub = 'sub-p1';
        const c = await connect(tokenFor(doc, sub, { wfp: 'p1' }));
        expect(await open(c, doc)).toMatchObject({ participant: 'p1', roles: ['tenant'] });
        const refresh = async (claims: Record<string, unknown>) => {
          const id = c.nextId();
          c.send({ t: 'auth.refresh', id, ch: 1, d: { token: tokenFor(doc, sub, claims) } });
          expect((await c.take((m) => m.re === id, 5000, 'answer to auth.refresh')).t).toBe(
            'auth.ok',
          );
        };
        // The same claims: access did not change, so nothing is sent.
        const before = c.all('perm.changed', 1).length;
        await refresh({ wfp: 'p1' });
        expect(c.all('perm.changed', 1)).toHaveLength(before);
        // The perm.changed messages of the channel after the first view, in order.
        const perm = async (n: number) => {
          for (let i = 0; i < 100 && c.all('perm.changed', 1).length <= n; i++)
            await new Promise((r) => setTimeout(r, 30));
          return c.all('perm.changed', 1)[n]!;
        };
        // A wfp that binds to no one: the fill capability goes.
        await refresh({ wfp: 'nobody' });
        const lost = await perm(before);
        expect((lost.d as { fill: unknown }).fill).toBeNull();
        const refused = await c.submit(1, { base: await base(ref), steps: [set('Ada')] });
        expect(refused.t).toBe('sync.reject');
        // And back to the participant: the capability returns with the participant's roles.
        await refresh({ wfp: 'p1' });
        const back = await perm(before + 1);
        expect((back.d as { fill: unknown }).fill).toEqual({
          participant: 'p1',
          roles: ['tenant'],
          active: true,
        });
        const ack = await c.submit(1, { base: await base(ref), steps: [set('Bea')] });
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
      },
    );

    for (const end of ['declined', 'voided', 'expired'] as const) {
      it.skipIf(skip)(
        `takes the capability away when the workflow is ${end}, though the token has not expired (criterion 6)`,
        async () => {
          const { doc, owner, ref } = await workflow(true, {
            deadline: new Date(h.now() + HOUR).toISOString(),
          });
          const token = tokenFor(doc, 'sub-p1', { wfp: 'p1' });
          const c = await connect(token);
          expect(await open(c, doc)).toMatchObject({ participant: 'p1' });
          const first = await c.submit(1, { base: await base(ref), steps: [set('Ada')] });
          expect(first.t, JSON.stringify(first)).toBe('sync.ack');

          if (end === 'voided') {
            const r = await post(`/v1/documents/${doc}/workflow/void`, owner, { reason: 'Stop' });
            expect(r.status, r.text).toBe(200);
          } else if (end === 'declined') {
            // The participant opened the document, so the workflow is in progress (FRW-040).
            const r = await post(`/v1/documents/${doc}/workflow/participants/p1/decline`, token, {
              reason: 'No',
            });
            expect(r.status, r.text).toBe(200);
          } else {
            h.advance(HOUR);
            const done = await sweepTenant(
              {
                workflows: h.parts.workflows!,
                reminders: h.parts.reminders!,
                grants: h.parts.grants,
                logs: h.parts.logs,
                notifier: h.service.dataPlane,
                audit: h.parts.audit,
                now: h.now,
                controlWaitMs: 5000,
                events: h.events,
              },
              h.tenant,
            );
            expect(done.expired).toContain(doc);
          }
          expect((await h.parts.workflows!.read(ref.tenant, ref.doc))!.state).toBe(end);

          // The connected participant is told, and a fill is refused.
          const changed = await c.take(
            (m) => m.t === 'perm.changed' && m.ch === 1 && (m.d as { fill: unknown }).fill === null,
            5000,
            'perm.changed without fill',
          );
          expect(changed.t).toBe('perm.changed');
          const refused = await c.submit(1, { base: await base(ref), steps: [set('Bea')] });
          expect(refused.t).toBe('sync.reject');

          // The token is still valid: it opens a channel, which gives no fill capability.
          // (After the clock moved for the expiry the first token is old, so a new one is minted.)
          const again = await connect(
            end === 'expired' ? tokenFor(doc, 'sub-p1', { wfp: 'p1' }) : token,
          );
          expect(await open(again, doc)).toBeNull();
          const late = await again.submit(1, { base: await base(ref), steps: [set('Cy')] });
          expect(late.t).toBe('sync.reject');
        },
      );
    }
  });
}
