// FRW-012 through the real service: a region granted to the role placeholder `role:tenant` (12 §3.4,
// §4.3; 07 §1, §4 limit 1; owner decision 132 of 2026-11-15, FRW-086 option a). The grant is stored
// through `PATCH /documents/{id}/grants`, the workflow through `PUT /documents/{id}/workflow`, and a
// participant is bound to the role by its token (`wfp` and `sub`, FRW-038), never by a claim of its
// own. The real data plane, a real WebSocket client, memory storage and, when the test environment
// is up, PostgreSQL in Podman.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient, insertText, type Received } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const LEGAL_PARAGRAPH = 'pLegal0000000001';

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cb2',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 3, sub: 'sub-p2' },
    { id: 'p3', roles: ['tenant'], kind: 'filler', order: 2, sub: 'sub-p3' },
  ],
});

/** The access object of a `ch.opened` (a member) or of a `perm.changed` (the message itself). */
const accessOf = (d: unknown): { rev: number; scopes: Record<string, string[]> } =>
  (d as { access?: never }).access ?? (d as never);
/** The capabilities of the granted region. */
const caps = (d: unknown): string[] => accessOf(d).scopes[`region:${LEGAL}`] ?? [];
const rev = (d: unknown): number => accessOf(d).rev;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a region granted to a role (${storage}; FRW-012)`, async () => {
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
    /** A step that types at the start of the granted region's paragraph. */
    const typing = (text: string) => insertText(posOf(tree(), LEGAL_PARAGRAPH) + 1, text);

    const post = async (path: string, token: string, body?: unknown) => {
      const r = await h.call('POST', path, { token, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${path} ${r.text}`).toBe(200);
      return r;
    };

    /** A document whose region is granted to `role:tenant`, with a draft workflow, sent or not. */
    async function granted(send: boolean) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-012-${uuid7()}` });
      const read = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const put = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: owner,
        body: { grants: [{ region: LEGAL, principal: 'role:tenant', role: 'editor' }] },
        headers: { 'If-Match': read.headers.get('etag')! },
      });
      expect(put.status, put.text).toBe(200);
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const sendNow = () => post(`/v1/documents/${doc}/workflow/send`, owner);
      if (send) await sendNow();
      return { doc, owner, ref: { tenant: h.tenant, doc }, sendNow };
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
    /** Opens the channel; a bound participant's first view is recorded before this returns. */
    async function open(c: DepClient, doc: string): Promise<Received> {
      const o = await c.open(1, doc);
      expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
      const pid = (o.d as { access: { fill: { participant?: string } | null } }).access.fill
        ?.participant;
      if (pid !== undefined) {
        for (let i = 0; i < 100; i++) {
          const row = await h.parts.workflows!.read(h.tenant, doc);
          if (row?.participants.find((p) => p.id === pid)?.firstViewedAt !== undefined) break;
          await new Promise((r) => setTimeout(r, 30));
        }
      }
      return o;
    }
    const base = async (ref: { tenant: string; doc: string }) => (await h.parts.logs.head(ref)).seq;
    const typeInto = async (c: DepClient, ref: { tenant: string; doc: string }, text: string) =>
      c.submit(1, { base: await base(ref), steps: [typing(text)] });
    /**
     * The next `perm.changed` of channel 1, not yet taken, after which the region is (or is not)
     * editable. Other changes the transitions make on the way (a first view, a lock that stays)
     * are passed over.
     */
    const permEdit = (c: DepClient, editable: boolean, above = -1): Promise<Received> =>
      c.take(
        (m) =>
          m.t === 'perm.changed' &&
          m.ch === 1 &&
          caps(m.d).includes('edit') === editable &&
          rev(m.d) > above,
        5000,
        `perm.changed with edit ${editable}`,
      );

    it.skipIf(skip)(
      'gives the granted role to the participant bound to the role, by sub, and to nobody else (criterion 1)',
      async () => {
        const { doc, ref } = await granted(true);
        // The tenant, bound by `wfp` and `sub`, is active (order 1) and edits the region while the
        // document is sent: the commit is theirs, with the origin of an edit.
        const tenant = await connect(tokenFor(doc, 'sub-p1', { wfp: 'p1' }));
        const opened = await open(tenant, doc);
        expect(caps(opened.d)).toEqual(expect.arrayContaining(['view', 'comment', 'edit']));
        const ack = await typeInto(tenant, ref, 'Rent: ');
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
        // Only the region: the grant gives no `structure` and no `manage`, and no edit of the body.
        expect(caps(opened.d)).not.toContain('structure');
        expect(caps(opened.d)).not.toContain('manage');
        expect(accessOf(opened.d).scopes['body']).not.toContain('edit');

        // The landlord holds another role (and waits for its turn): the grant is not theirs.
        const landlord = await connect(tokenFor(doc, 'sub-p2', { wfp: 'p2' }));
        const other = await open(landlord, doc);
        expect(caps(other.d)).not.toContain('edit');
        expect((await typeInto(landlord, ref, 'x')).t).toBe('sync.reject');

        // The same sub with no `wfp`, and the tenant's `wfp` with another sub, are bound to
        // nothing, so the grant is not theirs either.
        for (const [sub, claims] of [
          ['sub-p1', {}],
          ['sub-stranger', { wfp: 'p1' }],
        ] as Array<[string, Record<string, unknown>]>) {
          const c = await connect(tokenFor(doc, sub, claims));
          const o = await open(c, doc);
          expect(caps(o.d), JSON.stringify(claims)).not.toContain('edit');
          expect((await typeInto(c, ref, 'x')).t, JSON.stringify(claims)).toBe('sync.reject');
        }
      },
    );

    it.skipIf(skip)(
      'recomputes access and sends perm.changed with a higher rev when the binding changes (criterion 3)',
      async () => {
        const { doc, owner, ref, sendNow } = await granted(false);

        // Before the send nobody is bound: a connected participant holds no `edit`. The send binds
        // the participants, and the connection is told with a higher rev.
        const c = await connect(tokenFor(doc, 'sub-p1', { wfp: 'p1' }));
        const draft = await open(c, doc);
        expect(caps(draft.d)).not.toContain('edit');
        await sendNow();
        const sent = await permEdit(c, true);
        expect(rev(sent.d)).toBeGreaterThan(rev(draft.d));
        expect((await typeInto(c, ref, 'A')).t).toBe('sync.ack');
        // The participant's first view after the send puts the workflow in progress.
        await open(await connect(tokenFor(doc, 'sub-p1', { wfp: 'p1' })), doc);
        expect((await h.parts.workflows!.read(h.tenant, doc))!.state).toBe('in_progress');

        // Correction pauses the participants: the grant is taken away, with a higher rev, and a
        // commit is refused.
        await post(`/v1/documents/${doc}/workflow/correct`, owner);
        const paused = await permEdit(c, false, rev(sent.d));
        expect((await typeInto(c, ref, 'B')).t).toBe('sync.reject');

        // Resume locks the document again and the participant is bound once more.
        await post(`/v1/documents/${doc}/workflow/resume`, owner);
        const back = await permEdit(c, true, rev(paused.d));
        expect((await typeInto(c, ref, 'C')).t).toBe('sync.ack');

        // A refreshed token that names another participant changes the binding with no change of the
        // grants: access is recomputed, `perm.changed` is sent and the rev is not lower.
        const refresh = async (claims: Record<string, unknown>) => {
          const id = c.nextId();
          c.send({ t: 'auth.refresh', id, ch: 1, d: { token: tokenFor(doc, 'sub-p1', claims) } });
          expect((await c.take((m) => m.re === id, 5000, 'answer to auth.refresh')).t).toBe(
            'auth.ok',
          );
        };
        await refresh({ wfp: 'p2' });
        const away = await permEdit(c, false);
        expect(rev(away.d)).toBeGreaterThanOrEqual(rev(back.d));
        await refresh({ wfp: 'p1' });
        const again = await permEdit(c, true, rev(away.d) - 1);
        expect(rev(again.d)).toBeGreaterThanOrEqual(rev(away.d));
      },
    );

    it.skipIf(skip)(
      'gives the grant to the next participant of the role when the order moves on, and takes it from the one who completed',
      async () => {
        const { doc, ref } = await granted(true);
        const first = await connect(tokenFor(doc, 'sub-p1', { wfp: 'p1' }));
        const second = await connect(tokenFor(doc, 'sub-p3', { wfp: 'p3' }));
        const waiting = await open(second, doc);
        // The second tenant holds the role but waits for its turn (order 2): no `edit` yet.
        expect(caps(waiting.d)).not.toContain('edit');
        expect((await typeInto(second, ref, 'x')).t).toBe('sync.reject');
        const opened = await open(first, doc);
        expect(caps(opened.d)).toContain('edit');

        const done = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/complete`,
          {
            token: tokenFor(doc, 'sub-p1', { wfp: 'p1' }),
            body: {},
          },
        );
        expect(done.status, done.text).toBe(200);

        const gained = await permEdit(second, true);
        expect(rev(gained.d)).toBeGreaterThanOrEqual(rev(waiting.d));
        expect((await typeInto(second, ref, 'y')).t).toBe('sync.ack');
        await permEdit(first, false);
        expect((await typeInto(first, ref, 'z')).t).toBe('sync.reject');
      },
    );
  });
}
