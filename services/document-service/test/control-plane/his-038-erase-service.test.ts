// HIS-038 through the service path (lane w7, 2026-11-17): the route `POST /users/erase` erases a
// person while the log stays as it was. Two people with host subs (e-mail shaped, unique to the
// run) connect over a real WebSocket to the real data plane, which stamps their commits with their
// surrogates. Then the service credential erases one of them, and the test compares what storage
// holds before and after.
//
// Criteria covered, on memory and on PostgreSQL unless marked:
// 1  the mapping row and the display name are gone, the commits are byte-identical, and (PostgreSQL)
//    the read markers of the person are gone and the other person's are not;
// 2  the history list, the attribution and the comparison still name the person's contributions,
//    under an identifier that no longer leads to a sub (the interface shows it as an unknown
//    person: packages/ui/test/his-009, his-015, his-028 and his-013);
// 3  (PostgreSQL) `PgLogStore.verify` is `ok` before and after;
// 4  (PostgreSQL) a dump of every table of the database holds the sub before the erasure only in the
//    mapping row, and holds it nowhere after; on memory the log, the audit trail and the events
//    are scanned;
// 6  a user token is refused, a bad body is refused, an unknown person is `not_found`, and the
//    erasure is audited under the actor of the credential without the sub.
// Test values only. Each PostgreSQL run has a database of its own, dropped afterwards.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A position inside the first text block of the document, where a text step can go. */
function textPosition(doc: unknown): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (found < 0 && n.isTextblock) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error('no text block');
  return found;
}

/** Every row of every table of the database, as text, keyed by table (PostgreSQL only). */
async function dumpDatabase(h: Harness): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tables = await h.db!.admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  for (const { table_name } of tables.rows) {
    const rows = await h.db!.admin.query<{ t: string }>(
      `SELECT to_jsonb(x)::text AS t FROM "${table_name}" x`,
    );
    out.set(table_name, rows.rows.map((r) => r.t).join('\n'));
  }
  return out;
}

const tablesHolding = (dump: Map<string, string>, needle: string): string[] =>
  [...dump].filter(([, text]) => text.includes(needle)).map(([name]) => name);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`erasing a person through POST /users/erase (${storage}, HIS-038)`, async () => {
    const skip = await skipReason(storage);
    if (skip) console.warn(`skipped: ${skip}`);
    let h: Harness;
    const clients: DepClient[] = [];
    let doc: string;
    const subs = {
      alice: `w7-alice-${unique()}@example.test`,
      bob: `w7-bob-${unique()}@example.test`,
    };
    const names = { alice: 'Alice Example', bob: 'Bob Example' };
    let alice = '';
    let bob = '';
    let owner = '';

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ title: 'w7 HIS-038' });
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const pos = textPosition(content.json.doc);
      const connect = async (token: string): Promise<DepClient> => {
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        expect((await c.hello(token)).t).toBe('welcome');
        return c;
      };
      const a = await connect(
        h.userToken({ [doc]: 'editor' }, { sub: subs.alice, name: names.alice, jti: uuid7() }),
      );
      const b = await connect(
        h.userToken({ [doc]: 'editor' }, { sub: subs.bob, name: names.bob, jti: uuid7() }),
      );
      expect((await a.open(1, doc)).t).toBe('ch.opened');
      expect((await b.open(1, doc)).t).toBe('ch.opened');
      for (const [client, base, text] of [
        [a, 0, 'A'],
        [b, 1, 'B'],
        [a, 2, 'C'],
      ] as const) {
        const r = await client.submit(1, { base, steps: [insertText(pos, text)] });
        expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
      }
      alice = (await h.parts.users.resolve(h.tenant, subs.alice)).surrogate;
      bob = (await h.parts.users.resolve(h.tenant, subs.bob)).surrogate;
      owner = h.userToken({ [doc]: 'owner' }, { sub: `w7-owner-${unique()}` });
    }, 60_000);

    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const erase = (body: unknown, token?: string) =>
      h.call('POST', '/v1/users/erase', { token: token ?? h.apiKey, body });
    const ref = () => ({ tenant: h.tenant, doc });
    const authorsOf = (r: { json: { items: Array<{ authors?: Array<{ user: string }> }> } }) =>
      r.json.items.flatMap((i) => (i.authors ?? []).map((a) => a.user));

    it.skipIf(skip)(
      'refuses a user token, a bad body and an unknown person, and changes nothing',
      async () => {
        const asUser = await erase({ sub: subs.alice }, owner);
        expect(asUser.status, asUser.text).toBe(403);
        for (const body of [{}, { sub: '' }, { sub: 7 }, { sub: 'x', extra: 1 }, 'alice']) {
          const r = await erase(body);
          expect(r.status, JSON.stringify(body)).toBe(400);
        }
        const unknown = await erase({ sub: `w7-nobody-${unique()}` });
        expect(unknown.status, unknown.text).toBe(404);
        expect(await h.parts.users.displayName(h.tenant, subs.alice)).toBe(names.alice);
        expect(await h.parts.users.surrogateOf(h.tenant, subs.alice)).toBe(alice);
      },
    );

    it.skipIf(skip)(
      'deletes the mapping and the name, leaves the log as it was, and audits it (criteria 1, 3, 4, 6)',
      async () => {
        const logBefore = JSON.stringify(await h.parts.logs.read(ref()));
        const headBefore = await h.parts.logs.head(ref());
        const pg = storage === 'postgres';
        let verifyBefore: unknown = null;
        let dumpBefore: Map<string, string> | null = null;
        if (pg) {
          // The person has a read marker, and so has the other person.
          await h.parts.readMarkers!.advance(ref(), alice, 4, Date.now());
          await h.parts.readMarkers!.advance(ref(), bob, 4, Date.now());
          verifyBefore = await (h.parts.logs as PgLogStore).verify(ref());
          expect(verifyBefore).toMatchObject({ ok: true });
          dumpBefore = await dumpDatabase(h);
          // The control: before the erasure the sub is in the mapping row, and nowhere else.
          expect(tablesHolding(dumpBefore, subs.alice)).toEqual(['tenant_users']);
          expect(tablesHolding(dumpBefore, names.alice)).toEqual(['tenant_users']);
        }
        const log = JSON.stringify(await h.parts.logs.read(ref()));
        expect(log).toContain(alice);
        expect(log).not.toContain(subs.alice);

        const r = await erase({ sub: subs.alice });
        expect(r.status, r.text).toBe(200);
        expect(r.json).toEqual({ outcome: 'erased' });

        expect(await h.parts.users.displayName(h.tenant, subs.alice)).toBeNull();
        expect(await h.parts.users.surrogateOf(h.tenant, subs.alice)).toBeNull();
        expect((await h.parts.users.subsOf(h.tenant, [alice])).size).toBe(0);
        expect(await h.parts.users.surrogateOf(h.tenant, subs.bob)).toBe(bob);
        expect(await h.parts.users.displayName(h.tenant, subs.bob)).toBe(names.bob);

        // Criterion 1: nothing in the log changes.
        expect(JSON.stringify(await h.parts.logs.read(ref()))).toBe(logBefore);
        expect(await h.parts.logs.head(ref())).toEqual(headBefore);

        // The audit trail names the erasure under the actor of the credential, without the sub.
        const events = await h.parts.audit!.query(h.tenant, { kind: 'erasure.run', limit: 100 });
        expect(events).toHaveLength(1);
        expect(events[0]!.actor).toBe('system');
        const audited = JSON.stringify(events);
        expect(audited).toContain(alice);
        expect(audited).not.toContain(subs.alice);

        if (pg) {
          // Criterion 1: the read markers of the person only.
          expect(await h.parts.readMarkers!.get(ref(), alice)).toBeUndefined();
          expect(await h.parts.readMarkers!.get(ref(), bob)).toBe(4);
          // Criterion 3: the chain verifies after the erasure, with the same verdict.
          expect(await (h.parts.logs as PgLogStore).verify(ref())).toEqual(verifyBefore);
          // Criterion 4: the sub and the name are in no table.
          const after = await dumpDatabase(h);
          expect(tablesHolding(after, subs.alice)).toEqual([]);
          expect(tablesHolding(after, names.alice)).toEqual([]);
          // The other person is untouched, and so is every table but the ones the erasure changes.
          expect(tablesHolding(after, subs.bob)).toEqual(['tenant_users']);
          const changed = [...after]
            .filter(([name, text]) => dumpBefore!.get(name) !== text)
            .map(([name]) => name.replace(/^audit_events_.*/, 'audit_events'));
          // `tenant_users` and `read_markers` are the erasure; `audit_events` records it.
          expect([...new Set(changed)].sort()).toEqual([
            'audit_events',
            'read_markers',
            'tenant_users',
          ]);
        } else {
          const everything = JSON.stringify([
            await h.parts.logs.read(ref()),
            await h.parts.audit!.query(h.tenant, { limit: 1000 }),
            h.events.events ?? [],
          ]);
          expect(everything).not.toContain(subs.alice);
        }

        // A second erasure finds nobody.
        expect((await erase({ sub: subs.alice })).status).toBe(404);
      },
      60_000,
    );

    it.skipIf(skip)(
      'still shows the contributions of the erased person, under an identifier that resolves to nobody (criterion 2)',
      async () => {
        const list = await h.call('GET', `/v1/documents/${doc}/history`, { token: owner });
        expect(list.status, list.text).toBe(200);
        const authors = authorsOf(list);
        // The contributions remain, attributed to the surrogate, never to the sub.
        expect(authors).toContain(alice);
        expect(authors).toContain(subs.bob);
        expect(list.text).not.toContain(subs.alice);
        expect((await h.parts.users.subsOf(h.tenant, [alice])).size).toBe(0);

        const who = await h.call('GET', `/v1/documents/${doc}/attribution`, { token: owner });
        expect(who.status, who.text).toBe(200);
        expect(who.text).toContain(alice);
        expect(who.text).not.toContain(subs.alice);
        expect(who.text).toContain(subs.bob);

        const head = (await h.parts.logs.head(ref())).seq;
        const diff = await h.call('GET', `/v1/documents/${doc}/diff?fromSeq=0&toSeq=${head}`, {
          token: owner,
        });
        expect(diff.status, diff.text).toBe(200);
        expect(diff.text).toContain(alice);
        expect(diff.text).not.toContain(subs.alice);
      },
    );
  });
}
