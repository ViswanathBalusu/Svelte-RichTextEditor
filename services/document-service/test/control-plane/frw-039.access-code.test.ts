// FRW-039 through the real service: a participant whose `auth.require` lists `access_code` fills
// only after they submit the code the host registered. The real data plane, a real WebSocket client
// and the REST routes, on memory storage and, when the test environment is up, PostgreSQL in
// Podman. The code input of the component (criterion 6) is the editor's and is not tested here.
// docs/adr/0393-w4-FRW-039-access-code.md (proposed).
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.ts';
import { DepClient } from '../data-plane/client.ts';
import { posOf, schema } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryAccessCodeStore } from '../../src/workflow/access-code-store.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const TENANT_FIELD = 'ffTenant00000001';
const CODE = `MARKER-ACCESS-CODE-${uuid7().slice(-12)}`;
const WRONG = `MARKER-WRONG-CODE-${uuid7().slice(-12)}`;

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

const BODY = (doc: string, auth: unknown = { require: ['access_code'] }) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1', auth },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
  ],
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`access code of a participant (${storage}; FRW-039)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    const logs: string[] = [];
    const answers: string[] = [];
    const codes = new MemoryAccessCodeStore();
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          realDataPlane: true,
          logger: createLogger((line) =>
            logs.push(typeof line === 'string' ? line : JSON.stringify(line)),
          ),
          // In memory the store is the one the test reads back; on PostgreSQL it is the table.
          ...(storage === 'memory' ? { parts: { accessCodes: codes } } : {}),
        });
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

    async function workflow(send = true) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-039-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      if (send) {
        const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(r.status, r.text).toBe(200);
      }
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    const participantToken = (doc: string, pid: string, sub = `sub-${pid}`) =>
      h.userToken({ [doc]: 'filler' }, { sub, wfp: pid });
    /** A REST call whose answer is kept, so that the test can look for the code in every one. */
    const call = async (
      method: string,
      path: string,
      opts: Parameters<Harness['call']>[2],
    ): Promise<Awaited<ReturnType<Harness['call']>>> => {
      const r = await h.call(method, path, opts);
      answers.push(r.text);
      return r;
    };
    const register = (doc: string, owner: string, pid: string, code = CODE) =>
      call('POST', `/v1/documents/${doc}/workflow/participants/${pid}/access-code`, {
        token: owner,
        body: { code },
      });
    const verify = (doc: string, pid: string, code: string, token = participantToken(doc, pid)) =>
      call('POST', `/v1/documents/${doc}/workflow/participants/${pid}/verify`, {
        token,
        body: { code },
      });

    async function connect(token: string): Promise<DepClient> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token)).t).toBe('welcome');
      return c;
    }
    const head = async (ref: { tenant: string; doc: string }) => (await h.parts.logs.head(ref)).seq;
    const failed = (doc: string) =>
      h.events.of('dep.workflow.auth_failed.v1').filter((e) => e.subject === doc);
    const attempts = async (doc: string) =>
      (await h.parts.evidence!.list(h.tenant, doc)).filter((r) => r.item === 'access_code');

    it.skipIf(skip)(
      'accepts only access_code in auth.require when the workflow is saved (criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-039-${uuid7()}` });
        for (const auth of [
          { require: ['sms_otp'] },
          { require: ['access_code', 'id_verification'] },
          { require: [1] },
          { require: ['access_code'], passcode: 'x' },
        ]) {
          const r = await call('PUT', `/v1/documents/${doc}/workflow`, {
            token: owner,
            body: BODY(doc, auth),
            headers: { 'if-match': '"0"' },
          });
          expect(r.status, JSON.stringify(auth)).toBe(400);
          expect(r.json.code).toBe('validation_failed');
        }
        const good = await call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: BODY(doc),
          headers: { 'if-match': '"0"' },
        });
        expect(good.status, good.text).toBe(201);
      },
    );

    it.skipIf(skip)(
      'registers a code only for a participant who needs one, with manage (criterion 3, the route)',
      async () => {
        const { doc, owner } = await workflow(false);
        const editor = h.userToken({ [doc]: 'editor' }, { sub: `ed-039-${uuid7()}` });
        const base = `/v1/documents/${doc}/workflow/participants`;
        expect((await register(doc, editor, 'p1')).status).toBe(403);
        // A participant who needs no code, and one who does not exist.
        expect((await register(doc, owner, 'p2')).status).toBe(409);
        expect((await register(doc, owner, 'nobody')).status).toBe(404);
        const bad = await call('POST', `${base}/p1/access-code`, { token: owner, body: {} });
        expect(bad.status).toBe(400);
        const ok = await register(doc, owner, 'p1');
        expect(ok.status, ok.text).toBe(204);
        expect(ok.text).toBe('');
        // A participant with no registered code cannot verify.
        const other = await workflow();
        const none = await verify(other.doc, 'p1', CODE);
        expect(none.status, none.text).toBe(409);
      },
    );

    it.skipIf(skip)(
      'keeps the fields read-only until the code is submitted, then lets the participant fill (criteria 1 and 2)',
      async () => {
        const { doc, owner, ref } = await workflow();
        expect((await register(doc, owner, 'p1')).status).toBe(204);
        const c = await connect(participantToken(doc, 'p1'));
        const opened = await c.open(1, doc);
        expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
        const od = opened.d as {
          access: { fill: Record<string, unknown> | null };
          workflow: { participant: { id: string; state: string } };
        };
        // It is their turn, but the code is still to be given: they may not fill, and are told why.
        expect(od.access.fill).toEqual({ participant: 'p1', roles: ['tenant'], active: false });
        expect(od.workflow.participant.state).toBe('unverified');
        const refused = await c.submit(1, { base: await head(ref), steps: [set('Ada')] });
        expect(refused.t).toBe('sync.reject');

        // A wrong code is refused, raises auth_failed and is recorded; nothing opens.
        const wrong = await verify(doc, 'p1', WRONG);
        expect(wrong.status, wrong.text).toBe(403);
        expect(wrong.json.code).toBe('forbidden');
        expect(failed(doc)).toHaveLength(1);
        expect(failed(doc)[0]!.data).toMatchObject({ document: doc, participant: 'p1' });
        const afterWrong = await attempts(doc);
        expect(afterWrong).toHaveLength(1);
        expect(afterWrong[0]!.evidence).toMatchObject({ items: { accessCode: { ok: false } } });
        expect((await c.submit(1, { base: await head(ref), steps: [set('Ada')] })).t).toBe(
          'sync.reject',
        );

        // The right code: the participant may fill, and is told with perm.changed.
        const before = c.all('perm.changed', 1).length;
        const right = await verify(doc, 'p1', CODE);
        expect(right.status, right.text).toBe(200);
        expect(
          right.json.participants.find((p: { id: string }) => p.id === 'p1').verifiedAt,
        ).toBeTypeOf('string');
        for (let i = 0; i < 100 && c.all('perm.changed', 1).length <= before; i++)
          await new Promise((r) => setTimeout(r, 30));
        const told = c.all('perm.changed', 1).at(-1)!;
        expect((told.d as { fill: unknown }).fill).toEqual({
          participant: 'p1',
          roles: ['tenant'],
          active: true,
        });
        const ack = await c.submit(1, { base: await head(ref), steps: [set('Bea')] });
        expect(ack.t, JSON.stringify(ack)).toBe('sync.ack');
        // The verification is in the evidence, beside the failed attempt, with the connection's facts.
        const rows = await attempts(doc);
        expect(rows.map((r) => (r.evidence.items['accessCode'] as { ok: boolean }).ok)).toEqual([
          false,
          true,
        ]);
        expect(rows[1]!.evidence).toMatchObject({ ipAddress: expect.any(String) });
        expect(failed(doc)).toHaveLength(1);
        // A second submission of the right code changes nothing and counts for nothing.
        expect((await verify(doc, 'p1', CODE)).status).toBe(200);
        expect(await attempts(doc)).toHaveLength(2);

        // Nobody but the participant proves the code: not the host's credential, not the owner.
        const other = await workflow();
        expect((await register(other.doc, other.owner, 'p1')).status).toBe(204);
        const asOwner = await verify(other.doc, 'p1', CODE, other.owner);
        expect(asOwner.status).toBe(403);
        const asHost = await verify(other.doc, 'p1', CODE, h.apiKey);
        expect([401, 403]).toContain(asHost.status);
        const wrongSub = await verify(
          other.doc,
          'p1',
          CODE,
          participantToken(other.doc, 'p1', 'sub-x'),
        );
        expect(wrongSub.status).toBe(403);
      },
      60_000,
    );

    it.skipIf(skip)(
      'stores a hash of the code and finds the code in no table, event, evidence row, log line or answer (criterion 3)',
      async () => {
        const { doc, owner } = await workflow();
        expect((await register(doc, owner, 'p1')).status).toBe(204);
        expect((await verify(doc, 'p1', WRONG)).status).toBe(403);
        expect((await verify(doc, 'p1', CODE)).status).toBe(200);

        const everywhere = [
          ...answers,
          ...logs,
          JSON.stringify(h.events.events),
          JSON.stringify(await h.parts.evidence!.list(h.tenant, doc)),
          JSON.stringify(await h.parts.logs.read({ tenant: h.tenant, doc })),
          ...(storage === 'memory' ? [codes.dump()] : []),
        ].join('\n');
        for (const marker of [CODE, WRONG]) expect(everywhere).not.toContain(marker);
        if (h.db !== null) {
          const tables = (
            await h.db.admin.query<{ t: string }>(
              `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
            )
          ).rows.map((r) => r.t);
          for (const t of tables)
            for (const marker of [CODE, WRONG]) {
              const r = await h.db.admin.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM "${t}" x WHERE x::text LIKE $1`,
                [`%${marker}%`],
              );
              expect(Number(r.rows[0]!.n), `${t} holds ${marker}`).toBe(0);
            }
          // What is stored is a salt and a hash: 32 and 64 hexadecimal digits.
          const row = await h.db.admin.query<{ salt: string; hash: string }>(
            `SELECT salt, hash FROM workflow_access_codes WHERE doc_id = $1 AND participant = 'p1'`,
            [doc],
          );
          expect(row.rows[0]!.salt).toMatch(/^[0-9a-f]{32}$/);
          expect(row.rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
        } else {
          expect(codes.dump()).toMatch(/"hash":"[0-9a-f]{64}"/);
        }
      },
    );

    it.skipIf(skip)(
      'limits repeated wrong codes with rate_limited and retryAfterMs, a right code included, until the window ends (criterion 4)',
      async () => {
        const { doc, owner } = await workflow();
        expect((await register(doc, owner, 'p1')).status).toBe(204);
        // Five attempts are allowed in a window; each wrong one is `forbidden`.
        for (let i = 0; i < 5; i++) {
          const r = await verify(doc, 'p1', `${WRONG}-${i}`);
          expect(r.status, `${i} ${r.text}`).toBe(403);
        }
        const sixth = await verify(doc, 'p1', CODE);
        expect(sixth.status, sixth.text).toBe(429);
        expect(sixth.json.code).toBe('rate_limited');
        expect(sixth.json.retryAfterMs).toBeGreaterThan(0);
        expect(sixth.json.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
        expect(Number(sixth.headers.get('retry-after'))).toBe(
          Math.ceil(sixth.json.retryAfterMs / 1000),
        );
        // The refused attempt is not recorded as a wrong one, and raises nothing.
        expect(failed(doc)).toHaveLength(5);
        // After the window the participant may try again, and the right code works.
        h.advance(15 * 60_000 + 1000);
        const again = await verify(doc, 'p1', CODE, participantToken(doc, 'p1'));
        expect(again.status, again.text).toBe(200);
      },
      60_000,
    );

    it.skipIf(skip)(
      'counts concurrent attempts so that no more than the limit get through (criterion 4)',
      async () => {
        const { doc, owner } = await workflow();
        expect((await register(doc, owner, 'p1')).status).toBe(204);
        const token = participantToken(doc, 'p1');
        const answered = await Promise.all(
          Array.from({ length: 12 }, (_, i) => verify(doc, 'p1', `${WRONG}-c${i}`, token)),
        );
        const statuses = answered.map((r) => r.status);
        expect(statuses.filter((s) => s === 403)).toHaveLength(5);
        expect(statuses.filter((s) => s === 429)).toHaveLength(7);
      },
      60_000,
    );
  });
}
