// HIS-003 criterion 3 on PostgreSQL, through the service (08 §2, last paragraph; owner decision 24).
//
// People connect over a real WebSocket to the real data plane of a service that runs on the
// PostgreSQL of the test environment, with the real user directory. Their sessions are recorded in
// `doc_sessions` (migration 0096) before their channels open: the surrogate, the user agent family
// with its major version, and the client version. The test then reads the table as the schema owner
// and scans every table, every commit payload and every raised event for what must not be stored:
// the host's `sub`, the display name, the header's own text, the origin and the address.
//
// It also shows that the database itself refuses free text in a record, that the service role can
// neither change nor delete one, that a record is written once, that it stays as long as the
// document's history and goes with the purge of the document (HIS-039), and that a channel does not
// open when the record cannot be stored.
//
// Skipped when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up. The database is
// made for this file and dropped afterwards. Test values only.
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import {
  DOC_SESSIONS_COLUMNS,
  DOC_SESSIONS_TABLE,
  PgSessionRecordStore,
} from '../../src/control-plane/session-records-pg.ts';
import type { SessionRecord } from '../../src/control-plane/session-records.ts';
import type { LogFields, Logger } from '../../src/log.ts';
import { inTenant } from '../../src/storage/db.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { ADMIN } from '../support/env.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';
const ORIGIN = 'https://app.example.test';

interface StoredRow {
  doc_id: string;
  tenant_id: string;
  session_id: string;
  user_id: string;
  ua_family: string;
  ua_major: number | null;
  client_version: string | null;
}

/** A position inside the first text block of the document, where a text step can go. */
function textPosition(doc: unknown): number {
  let found = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (found < 0 && n.isTextblock) found = pos + 1;
      return found < 0;
    });
  if (found < 0) throw new Error('no text block');
  return found;
}

describe.skipIf(skip !== null)('session records (HIS-003 criterion 3, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  const clients: DepClient[] = [];
  const logged: Array<LogFields & { level: string }> = [];
  const logger: Logger = {
    info: (f) => logged.push({ level: 'info', ...f }),
    warn: (f) => logged.push({ level: 'warn', ...f }),
    error: (f) => logged.push({ level: 'error', ...f }),
  };

  beforeAll(async () => {
    h = await startHarness('postgres', { realDataPlane: true, logger });
    // The purge role: the admin login, with every connection set to docedit_purge (migration 0073).
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
  }, 60_000);
  afterAll(async () => {
    for (const c of clients.splice(0)) c.terminate();
    await purgePool?.end();
    await h?.close();
  });

  const wsUrl = () => `${h.base.replace(/^http/, 'ws')}/dep`;

  /** A session: the upgrade request carries the headers, `hello` the client. */
  async function connect(
    token: string,
    opts: {
      userAgent?: string;
      origin?: string;
      client?: { name: string; version: string };
    } = {},
  ): Promise<{ client: DepClient; session: string }> {
    const client = await DepClient.connect(wsUrl(), {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.userAgent !== undefined ? { headers: { 'User-Agent': opts.userAgent } } : {}),
    });
    clients.push(client);
    const welcome = await client.hello(token, opts.client ? { client: opts.client } : {});
    expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
    return { client, session: welcome.d!['session'] as string };
  }

  const stored = async (doc: string): Promise<StoredRow[]> =>
    (
      await h.db!.admin.query<StoredRow>(
        `SELECT doc_id::text AS doc_id, tenant_id::text AS tenant_id, session_id, user_id,
                ua_family, ua_major, client_version
           FROM ${DOC_SESSIONS_TABLE} WHERE doc_id = $1 ORDER BY session_id COLLATE "C"`,
        [doc],
      )
    ).rows;

  /** The tables whose rows hold `needle` anywhere in their text (every column, as the owner). */
  async function tablesHolding(needle: string): Promise<string[]> {
    const tables = (
      await h.db!.admin.query<{ t: string }>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          ORDER BY 1`,
      )
    ).rows.map((x) => x.t);
    const hits: string[] = [];
    for (const t of tables) {
      const r = await h.db!.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${t}" x WHERE strpos(x::text, $1) > 0`,
        [needle],
      );
      if ((r.rows[0]?.n ?? 0) > 0) hits.push(t);
    }
    return hits;
  }

  it('has a table with the columns of a session record and no other', async () => {
    const columns = (
      await h.db!.admin.query<{ c: string; t: string; n: string }>(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [DOC_SESSIONS_TABLE],
      )
    ).rows;
    expect(columns.map((x) => x.c)).toEqual([...DOC_SESSIONS_COLUMNS]);
    expect(
      Object.fromEntries(columns.map((x) => [x.c, `${x.t}${x.n === 'NO' ? ' not null' : ''}`])),
    ).toEqual({
      doc_id: 'uuid not null',
      tenant_id: 'uuid not null',
      session_id: 'text not null',
      user_id: 'text not null',
      ua_family: 'text not null',
      ua_major: 'integer',
      client_version: 'text',
    });
    const key = (
      await h.db!.admin.query<{ cols: string[] }>(
        `SELECT array_agg(a.attname ORDER BY k.ord)::text[] AS cols
           FROM pg_constraint c
           JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.conrelid = $1::regclass AND c.contype = 'p' GROUP BY c.oid`,
        [DOC_SESSIONS_TABLE],
      )
    ).rows;
    expect(key.map((k) => k.cols)).toEqual([['doc_id', 'session_id']]);
  });

  it('stores the surrogate, the family, the major version and the client version of each session, and nothing else about the person', async () => {
    const doc = await h.createDocument({
      content: documentWithRegions(),
      title: 'HIS-003 sessions',
    });
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const pos = textPosition(content.json.doc);

    const run = randomUUID();
    const people = [
      { sub: `his003-alice-${run}@example.test`, name: `Alice Example ${run}` },
      { sub: `his003-bob-${run}`, name: `Bob Example ${run}` },
    ] as const;
    const alice = await connect(
      h.userToken({ [doc]: 'owner' }, { sub: people[0].sub, name: people[0].name }),
      { userAgent: EDGE, origin: ORIGIN, client: { name: '@docedit/element', version: '1.4.2' } },
    );
    const bob = await connect(
      h.userToken({ [doc]: 'editor' }, { sub: people[1].sub, name: people[1].name }),
      {
        userAgent: FIREFOX,
        origin: ORIGIN,
        // Free text where a version belongs: it is not kept.
        client: { name: 'a client', version: `build of ${people[1].name}` },
      },
    );
    expect((await alice.client.open(1, doc)).t).toBe('ch.opened');
    expect((await bob.client.open(1, doc)).t).toBe('ch.opened');
    const first = await alice.client.submit(1, { base: 0, steps: [insertText(pos, 'A')] });
    expect(first.t, JSON.stringify(first.d)).toBe('sync.ack');
    const second = await bob.client.submit(1, { base: 1, steps: [insertText(pos, 'B')] });
    expect(second.t, JSON.stringify(second.d)).toBe('sync.ack');

    // The mapping the service made for the two people: the real PgUserDirectory.
    const aliceId = await h.parts.users.surrogateOf(h.tenant, people[0].sub);
    const bobId = await h.parts.users.surrogateOf(h.tenant, people[1].sub);
    if (aliceId === null || bobId === null) throw new Error('a person has no surrogate');
    expect([aliceId, bobId]).not.toContain(people[0].sub);
    expect([aliceId, bobId]).not.toContain(people[1].sub);
    const rows = await stored(doc);
    const bySession = new Map(rows.map((r) => [r.session_id, r]));
    expect(rows).toHaveLength(2);
    expect(bySession.get(alice.session)).toEqual({
      doc_id: doc,
      tenant_id: h.tenant,
      session_id: alice.session,
      user_id: aliceId,
      ua_family: 'edge',
      ua_major: 137,
      client_version: '1.4.2',
    });
    expect(bySession.get(bob.session)).toEqual({
      doc_id: doc,
      tenant_id: h.tenant,
      session_id: bob.session,
      user_id: bobId,
      ua_family: 'firefox',
      ua_major: 142,
      client_version: null,
    });
    // The service reads the same through its own role and row-level security.
    expect(await h.parts.sessionRecords!.get(h.tenant, doc, alice.session)).toEqual({
      tenant: h.tenant,
      document: doc,
      session: alice.session,
      user: aliceId,
      userAgentFamily: 'edge',
      userAgentMajor: 137,
      clientVersion: '1.4.2',
    } satisfies SessionRecord);

    // Every commit that names a session has that session's record, with the same user.
    const orphans = await h.db!.admin.query(
      `SELECT c.seq FROM doc_commits c
        WHERE c.doc_id = $1 AND c.session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${DOC_SESSIONS_TABLE} s
                           WHERE s.doc_id = c.doc_id AND s.session_id = c.session_id
                             AND s.user_id = c.user_id)`,
      [doc],
    );
    expect(orphans.rows).toEqual([]);
    const commits = await h.db!.admin.query<{ session_id: string | null }>(
      `SELECT session_id FROM doc_commits WHERE doc_id = $1 AND kind = 'steps' ORDER BY seq`,
      [doc],
    );
    expect(commits.rows.map((r) => r.session_id)).toEqual([alice.session, bob.session]);

    // The scan (criteria 1 and 4 again, with the new table): the host's `sub` is in the mapping row
    // only, the display name too, and no table holds text of a `User-Agent` header.
    for (const p of people) {
      expect(await tablesHolding(p.sub), p.sub).toEqual(['tenant_users']);
      expect(await tablesHolding(p.name), p.name).toEqual(['tenant_users']);
    }
    for (const part of [
      EDGE,
      FIREFOX,
      'Mozilla/5.0',
      'Windows NT',
      'AppleWebKit',
      'Gecko/20100101',
    ])
      expect(await tablesHolding(part), part).toEqual([]);
    // The session rows hold neither the origin nor an address, and no client name.
    const dump = (
      await h.db!.admin.query<{ x: string }>(`SELECT s::text AS x FROM ${DOC_SESSIONS_TABLE} s`)
    ).rows
      .map((r) => r.x)
      .join('\n');
    for (const part of [
      ORIGIN,
      'app.example.test',
      '127.0.0.1',
      '::1',
      '@docedit/element',
      'a client',
    ])
      expect(dump, part).not.toContain(part);

    // Commit payloads (the hash inputs) and the events raised hold none of it either.
    const payloads = await h.db!.admin.query<{ payload: Buffer }>(
      'SELECT payload FROM doc_commit_payloads WHERE doc_id = $1',
      [doc],
    );
    expect(payloads.rows.length).toBeGreaterThanOrEqual(2);
    const texts = [
      ...payloads.rows.map((r) => zstdDecompressSync(r.payload).toString('utf8')),
      JSON.stringify(h.events.events),
    ];
    for (const text of texts)
      for (const secret of [...people.flatMap((p) => [p.sub, p.name]), 'Mozilla/5.0'])
        expect(text, secret).not.toContain(secret);
  }, 60_000);

  it('lets the database refuse free text, and the service role neither change nor delete a record', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const insert = (over: Partial<StoredRow>) =>
      inTenant(h.db!.service, h.tenant, (c) =>
        c.query(
          `INSERT INTO ${DOC_SESSIONS_TABLE}
                  (doc_id, tenant_id, session_id, user_id, ua_family, ua_major, client_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            doc,
            h.tenant,
            over.session_id ?? randomUUID(),
            over.user_id ?? 'surrogate-1',
            over.ua_family ?? 'chrome',
            over.ua_major === undefined ? 137 : over.ua_major,
            over.client_version === undefined ? '1.0.0' : over.client_version,
          ],
        ),
      );
    // What the service writes is accepted, with or without the optional values.
    await insert({});
    await insert({ ua_family: 'other', ua_major: null, client_version: null });
    const refused = { code: '23514' };
    await expect(insert({ ua_family: EDGE })).rejects.toMatchObject(refused);
    await expect(insert({ ua_family: 'Chrome' })).rejects.toMatchObject(refused);
    await expect(insert({ ua_major: 10000 })).rejects.toMatchObject(refused);
    await expect(insert({ ua_major: -1 })).rejects.toMatchObject(refused);
    await expect(insert({ client_version: 'Alice Example' })).rejects.toMatchObject(refused);
    await expect(insert({ client_version: 'alice@example.test' })).rejects.toMatchObject(refused);
    await expect(insert({ client_version: '1.0.0\nAlice' })).rejects.toMatchObject(refused);
    await expect(
      insert({ client_version: `1.0.0-${'a'.repeat(32)}+${'b'.repeat(30)}` }),
    ).rejects.toMatchObject(refused);
    await expect(insert({ user_id: 'Alice Example' })).rejects.toMatchObject(refused);
    await expect(insert({ session_id: '' })).rejects.toMatchObject(refused);
    // A record is written once: the service role holds no UPDATE and no DELETE on the table.
    for (const sql of [
      `UPDATE ${DOC_SESSIONS_TABLE} SET ua_family = 'other'`,
      `DELETE FROM ${DOC_SESSIONS_TABLE}`,
    ])
      await expect(
        inTenant(h.db!.service, h.tenant, (c) => c.query(sql)),
        sql,
      ).rejects.toMatchObject({ code: '42501' });
    expect(await stored(doc)).toHaveLength(2);
  });

  it('writes a record once, only for a live document of the tenant, and shows it to that tenant only', async () => {
    const store = new PgSessionRecordStore(h.db!.service);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const row: SessionRecord = {
      tenant: h.tenant,
      document: doc,
      session: `session-${randomUUID()}`,
      user: 'surrogate-1',
      userAgentFamily: 'safari',
      userAgentMajor: 17,
      clientVersion: '2.0.0-beta.1',
    };
    await store.record(row);
    // The same session again, with other values: the first record stays.
    await store.record({
      ...row,
      userAgentFamily: 'chrome',
      userAgentMajor: 1,
      clientVersion: null,
    });
    expect(await store.list(h.tenant, doc)).toEqual([row]);
    expect(await store.get(h.tenant, doc, row.session)).toEqual(row);
    expect(await store.get(h.tenant, doc, 'no-such-session')).toBeNull();

    // No document, no record, and no error: an unknown identifier, one that is not a UUID, another
    // tenant's document, and a deleted one.
    const other = randomUUID();
    await h.parts.registry.putTenant(other, 'Other tenant');
    await store.record({ ...row, document: randomUUID() });
    await store.record({ ...row, document: 'not-a-uuid' });
    await store.record({ ...row, tenant: other });
    expect(await store.list(other, doc)).toEqual([]);
    expect(await store.get(other, doc, row.session)).toBeNull();
    expect(await store.list(h.tenant, 'not-a-uuid')).toEqual([]);
    const gone = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [gone]: 'owner' }, { sub: `his003-owner-${randomUUID()}` });
    expect((await h.call('DELETE', `/v1/documents/${gone}`, { token: owner })).status).toBe(204);
    await store.record({ ...row, document: gone });
    expect(await stored(gone)).toEqual([]);
    const all = await h.db!.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${DOC_SESSIONS_TABLE} WHERE session_id = $1`,
      [row.session],
    );
    expect(all.rows[0]!.n).toBe(1);
  });

  it('keeps a record as long as the document, and the purge of the document removes it (HIS-039)', async () => {
    const kept = await h.createDocument({ content: documentWithRegions(), title: 'Kept' });
    const purged = await h.createDocument({ content: documentWithRegions(), title: 'Purged' });
    const sub = `his003-olga-${randomUUID()}`;
    const olga = await connect(h.userToken({ [kept]: 'owner', [purged]: 'owner' }, { sub }), {
      userAgent: EDGE,
      client: { name: 'c', version: '1.0.0' },
    });
    expect((await olga.client.open(1, kept)).t).toBe('ch.opened');
    expect((await olga.client.open(2, purged)).t).toBe('ch.opened');
    expect((await stored(kept)).map((r) => r.session_id)).toEqual([olga.session]);
    expect((await stored(purged)).map((r) => r.session_id)).toEqual([olga.session]);

    const del = await h.call('DELETE', `/v1/documents/${purged}`, {
      token: h.userToken({ [purged]: 'owner' }, { sub }),
    });
    expect(del.status, del.text).toBe(204);
    const purge = new DocumentPurge({
      store: new PgPurgeStore(purgePool),
      objects: h.parts.objects,
      audit: h.parts.audit!,
      retentionMs: 30 * DAY_MS,
      now: () => Date.now(),
    });
    // Deleted, with the retention still running: the history is still there, and so is the record.
    expect((await purge.run(h.tenant, new Set(), Date.now() + 29 * DAY_MS)).purged).toEqual([]);
    expect(await stored(purged)).toHaveLength(1);
    // Past the retention the document goes, and its session record with it; the other one stays.
    // (The run also purges the document an earlier test of this file deleted.)
    expect((await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS)).purged).toContain(
      purged,
    );
    expect(await stored(purged)).toEqual([]);
    expect(
      (await h.db!.admin.query('SELECT 1 FROM documents WHERE id = $1', [purged])).rowCount,
    ).toBe(0);
    expect((await stored(kept)).map((r) => r.session_id)).toEqual([olga.session]);
  }, 60_000);

  it('does not open a channel when the record cannot be stored, and reports it without the cause', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const pos = textPosition(content.json.doc);
    const erin = await connect(
      h.userToken({ [doc]: 'owner' }, { sub: `his003-erin-${randomUUID()}` }),
      { userAgent: FIREFOX, client: { name: 'c', version: '1.0.0' } },
    );
    // The table refuses the service's insert, as it would if the grant were missing.
    await h.db!.admin.query(`REVOKE INSERT ON ${DOC_SESSIONS_TABLE} FROM docedit_app`);
    try {
      const before = logged.length;
      const refused = await erin.client.open(1, doc);
      expect(refused.t).toBe('ch.rejected');
      expect(refused.d).toMatchObject({ code: 'unavailable' });
      expect(JSON.stringify(refused.d)).not.toMatch(/permission|doc_sessions/);
      const answer = await erin.client.submit(1, { base: 0, steps: [insertText(pos, 'x')] });
      expect(answer.t).toBe('error');
      expect(await stored(doc)).toEqual([]);
      expect(
        (await h.db!.admin.query('SELECT 1 FROM doc_commits WHERE doc_id = $1', [doc])).rowCount,
      ).toBe(0);
      const lines = logged.slice(before).filter((l) => l.event === 'data-plane.error');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'error',
        message: 'session.opened',
        tenant: h.tenant,
        doc,
        session: erin.session,
      });
    } finally {
      await h.db!.admin.query(`GRANT INSERT ON ${DOC_SESSIONS_TABLE} TO docedit_app`);
    }
    // With the table writable again the same session opens the document and is recorded.
    expect((await erin.client.open(1, doc)).t).toBe('ch.opened');
    expect((await stored(doc)).map((r) => r.session_id)).toEqual([erin.session]);
    const ack = await erin.client.submit(1, { base: 0, steps: [insertText(pos, 'x')] });
    expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
  }, 60_000);
});
