// The data plane over the PostgreSQL stores, with real WebSocket clients (BE-019, BE-024, BE-025,
// BE-026; HIS-001, HIS-002, HIS-003): what is acknowledged is what is stored, every field of the
// commit record, the hash chain with an independent check, and no personal data in the log.
// Skips when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { webcrypto } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { canonicalize, uuid7 } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

interface Row {
  seq: string;
  kind: string;
  commit_id: string;
  user_id: string;
  session_id: string | null;
  agent: string | null;
  server_ts: Date;
  origin: string;
  base: string | null;
  rebased: boolean | null;
  access_rev: string;
  token_jti: string | null;
  cdm_version: number;
  engine: string;
  size: number;
  payload_hash: Buffer;
  prev_hash: Buffer | null;
  hash: Buffer;
  payload: Buffer;
  scopes: string[];
}

describe.skipIf(unavailable !== null)('the data plane over PostgreSQL', () => {
  let db: TestDatabase;
  let p: Plane;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });
  afterEach(async () => {
    await p?.close();
  });

  async function pgPlane(): Promise<Plane> {
    const s = pgStores(db.service);
    p = await startPlane({
      stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
    });
    return p;
  }

  const rows = async (doc: string): Promise<Row[]> =>
    (
      await db.admin.query<Row>(
        `SELECT c.*, p.payload, coalesce(
                  (SELECT array_agg(s.scope ORDER BY s.scope) FROM commit_scopes s
                    WHERE s.doc_id = c.doc_id AND s.seq = c.seq), '{}') AS scopes
           FROM doc_commits c JOIN doc_commit_payloads p USING (doc_id, seq)
          WHERE c.doc_id = $1 ORDER BY c.seq`,
        [doc],
      )
    ).rows;

  it('stores what it acknowledges, in one write per batch, and serves it to a new room', async () => {
    await pgPlane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await b.open(1, doc);
    const acks = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        (i % 2 ? b : a).submit(1, { base: 0, steps: [insertText(intro(), String(i))] }),
      ),
    );
    // Two clients, one commit in flight each: everything lands, rebased where needed.
    expect(
      acks.filter((m) => m.t === 'sync.ack').length +
        acks.filter((m) => m.t === 'sync.reject').length,
    ).toBe(4);
    const log = await p.stores.logs.read(p.ref(doc));
    for (const ack of acks.filter((m) => m.t === 'sync.ack'))
      expect(log.find((c) => c.seq === ack.d!['seq'])?.id).toBe(ack.d!['id']);
    const content = await p.plane.readContent(
      p.tokens.identity(p.tokens.issue({ user: 'carol', docs: { [doc]: 'editor' } })),
      doc,
    );
    expect(content.seq).toBe(log.length);
  });

  it('records every field of a commit, the rebased steps as applied and the token jti (HIS-001)', async () => {
    await pgPlane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const c = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await c.open(1, doc);
    // Alice's first commit is not rebased; Carol's, at the same base, is.
    const first = await a.submit(1, {
      base: 0,
      steps: [insertText(intro(), 'A')],
      origin: 'input',
    });
    const second = await c.submit(1, {
      base: 0,
      steps: [insertText(intro(), 'C')],
      origin: 'paste',
    });
    expect(second.d!['rebased']).toBe(true);
    await p.changeGrants(doc, {
      putGrants: [
        { region: 'rNotes000000000C', principal: 'user:dave', role: 'viewer', expiresAt: null },
      ],
    });
    await until(() => c.all('perm.changed').length === 1);
    const r = await rows(doc);
    expect(r.map((x) => x.kind)).toEqual(['steps', 'steps', 'control']);
    const welcome = (x: typeof a) => x.log.find((m) => m.t === 'welcome')!.d!['session'];
    expect(r[0]).toMatchObject({
      seq: '1',
      commit_id: first.d!['id'],
      user_id: 'alice',
      session_id: welcome(a),
      agent: null,
      origin: 'input',
      base: '0',
      rebased: false,
      access_rev: '1',
      cdm_version: 1,
      engine: 'pm-steps/1',
      scopes: ['body'],
    });
    // The `jti` of the token the channel was opened with (08 §2).
    expect(r[0]!.token_jti).toBe(p.tokens.identity(a.token!).jti);
    expect(r[1]!.token_jti).toBe(p.tokens.identity(c.token!).jti);
    expect(r[1]).toMatchObject({
      seq: '2',
      commit_id: second.d!['id'],
      user_id: 'carol',
      session_id: welcome(c),
      origin: 'paste',
      base: '0',
      rebased: true,
    });
    // The payload is the steps as applied, which the acknowledgement carried (not as sent).
    const payload = JSON.parse(zstdDecompressSync(r[1]!.payload).toString('utf8'));
    expect(payload.steps).toEqual(second.d!['steps']);
    expect(payload.steps[0].from).toBe(intro() + 1);
    expect(r[1]!.size).toBe(Buffer.byteLength(canonicalize(payload)));
    // A control commit: the system, no user session, a reserved origin, the new revision.
    expect(r[2]).toMatchObject({
      kind: 'control',
      user_id: 'system',
      session_id: null,
      origin: 'control',
      access_rev: '2',
      base: null,
      rebased: null,
      token_jti: null,
    });
    // A restarted room rebuilds an acknowledgement from the record (SYN-008).
    const stored = await p.stores.logs.read(p.ref(doc), 2, 2);
    expect(stored[0]).toMatchObject({ base: 0, rebased: true, steps: second.d!['steps'] });
    const again = await c.submit(1, {
      id: second.d!['id'],
      base: 0,
      steps: [insertText(intro(), 'C')],
    });
    expect(again.d).toMatchObject({ id: second.d!['id'], seq: 2, steps: second.d!['steps'] });
  });

  it('chains every commit by hash, control commits too, and an independent check agrees (HIS-002)', async () => {
    await pgPlane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    for (let i = 0; i < 3; i++)
      await a.submit(1, { base: i, steps: [insertText(intro(), String(i))] });
    await p.changeGrants(doc, {
      setRegionStates: [{ region: 'rTerms000000000A', state: 'in_review' }],
    });
    await until(() => a.all('perm.changed').length === 1);
    const r = await rows(doc);
    expect(r).toHaveLength(4);
    // An independent implementation: WebCrypto and the columns, not the store's code.
    const sha = async (...parts: Uint8Array[]) => {
      const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of parts) {
        all.set(x, o);
        o += x.length;
      }
      return new Uint8Array(await webcrypto.subtle.digest('SHA-256', all));
    };
    let prev = new Uint8Array(32);
    for (const x of r) {
      const json = zstdDecompressSync(x.payload);
      expect(Buffer.from(await sha(json)).equals(x.payload_hash)).toBe(true);
      const meta = new TextEncoder().encode(
        canonicalize({
          doc,
          seq: Number(x.seq),
          kind: x.kind,
          id: x.commit_id,
          user: x.user_id,
          session: x.session_id,
          agent: x.agent,
          time: x.server_ts.toISOString(),
          origin: x.origin,
          scopes: x.scopes,
          base: x.base === null ? null : Number(x.base),
          rebased: x.rebased,
          revision: Number(x.access_rev),
          jti: x.token_jti,
          cdm: x.cdm_version,
          engine: x.engine,
          size: x.size,
        }),
      );
      const h = await sha(prev, meta, x.payload_hash);
      expect(Buffer.from(h).equals(x.hash)).toBe(true);
      expect(x.prev_hash === null ? null : x.prev_hash.toString('hex')).toBe(
        Number(x.seq) === 1 ? null : Buffer.from(prev).toString('hex'),
      );
      prev = h;
    }
    const logs = pgStores(db.service).logs;
    expect(await logs.verify(p.ref(doc))).toEqual({ ok: true, head: 4 });
    // A payload replaced by a tombstone still verifies: the row keeps the payload's hash.
    await db.admin.query(
      `UPDATE doc_commit_payloads SET payload = '\\x00' WHERE doc_id = $1 AND seq = 2`,
      [doc],
    );
    expect(await logs.verify(p.ref(doc))).toEqual({ ok: true, head: 4 });
    // One metadata field altered in storage: the first seq whose hash no longer matches.
    await db.admin.query(`UPDATE doc_commits SET origin = 'paste' WHERE doc_id = $1 AND seq = 3`, [
      doc,
    ]);
    expect(await logs.verify(p.ref(doc))).toMatchObject({ ok: false, seq: 3 });
  });

  it('keeps the host sub and the display name out of every table it writes (HIS-003)', async () => {
    await pgPlane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' }, { name: 'Alice Example' });
    const b = await p.client(
      'bob',
      { [doc]: 'editor' },
      { name: 'Bob Example', groups: ['legal'] },
    );
    await a.open(1, doc);
    await b.open(1, doc);
    await a.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    a.send({
      t: 'presence.update',
      ch: 1,
      d: { seq: 1, state: { selection: { anchor: 3, head: 3 }, scope: 'body', status: 'active' } },
    });
    await b.take((m) => m.t === 'presence.state');
    await p.changeGrants(doc, {
      removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }],
    });
    await until(() => b.all('perm.changed').length === 1);
    // The tokens' host `sub` values are host-alice and host-bob; the surrogates alice and bob.
    const tables = (
      await db.admin.query<{ t: string }>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
      )
    ).rows.map((x) => x.t);
    for (const t of tables) {
      const dump = (await db.admin.query<{ x: string }>(`SELECT t::text AS x FROM ${t} t`)).rows
        .map((x) => x.x)
        .join('\n');
      for (const secret of ['host-alice', 'host-bob', 'Alice Example', 'Bob Example'])
        expect(dump, `${secret} in ${t}`).not.toContain(secret);
    }
    // Payloads and hash inputs: the decompressed payloads too.
    for (const x of await rows(doc)) {
      const json = zstdDecompressSync(x.payload).toString('utf8');
      expect(json).not.toMatch(/host-alice|host-bob|Alice Example|Bob Example/);
      expect(['alice', 'bob', 'system']).toContain(x.user_id);
    }
  });

  it('refuses a write under a replaced revision and resubmits under the new one (BE-026)', async () => {
    await pgPlane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    await bob.open(1, doc);
    await p.changeGrants(
      doc,
      { removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }] },
      false,
    );
    const legal = posInside(baseDoc(), 'pLegal000000001B');
    const id = uuid7();
    expect((await bob.submit(1, { id, base: 0, steps: [insertText(legal, 'x')] })).d).toMatchObject(
      {
        code: 'unavailable',
      },
    );
    expect((await bob.submit(1, { id, base: 1, steps: [insertText(legal, 'x')] })).d).toMatchObject(
      {
        code: 'permission_denied',
      },
    );
    // The control commit of the new revision is written after the refusal; nothing else is.
    await bob.take((m) => m.t === 'perm.changed');
    expect((await rows(doc)).map((x) => [x.kind, x.access_rev])).toEqual([['control', '2']]);
  });

  it('answers a resubmitted stored commit as a duplicate after a new room opened (BE-025)', async () => {
    await pgPlane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const id = uuid7();
    const ack = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'x')] });
    const dup = await a.submit(1, { id, base: 1, steps: [insertText(intro(), 'x')] });
    expect(dup.d).toMatchObject({ id, seq: ack.d!['seq'] });
    expect((await rows(doc)).length).toBe(1);
  });
});
