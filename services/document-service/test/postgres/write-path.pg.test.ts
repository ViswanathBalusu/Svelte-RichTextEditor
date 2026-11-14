// The write path in PostgreSQL (BE-009, BE-024; 08 §2): which tables one write touches, what a
// stored commit holds, per-scope history through commit_scopes, and the hash chain.
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { canonicalize } from '@docedit/model';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainHash, createPool, PgGrantStore, PgLogStore } from '../../src/index.ts';
import {
  controlCommit,
  newDocument,
  stepCommit,
  TERMS,
  write,
  type StoreHarness,
} from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('write path (PostgreSQL)', () => {
  let db: TestDatabase;
  let h: StoreHarness;
  beforeAll(async () => {
    db = await createTestDatabase();
    const s = pgStores(db.service);
    h = {
      tenant: newTenant(),
      otherTenant: newTenant(),
      docs: s.docs,
      logs: s.logs,
      grants: s.grants,
    };
  });
  afterAll(() => db?.drop());

  it('touches the head row, the log tables and the revision row, never the documents row', async () => {
    const { ref, epoch } = await newDocument(h);
    // Record every statement the store sends, and the tables the transaction touched.
    const statements: string[] = [];
    const pool = createPool({ ...db.serviceConfig, max: 2 });
    pool.on('connect', (client: pg.PoolClient) => {
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as { query: unknown }).query = (...a: unknown[]) => {
        const first = a[0];
        statements.push(
          typeof first === 'string' ? first : String((first as { text?: string }).text),
        );
        return query(...a);
      };
    });
    const grants = new PgGrantStore(pool);
    const logs = new PgLogStore(pool, { permissions: (r) => grants.current(r) });
    let touched: Array<{ relname: string; reads: number; writes: number }> = [];
    try {
      const r = await logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2)]), {
        beforeCommit: async (c) => {
          touched = (
            await c.query<{ relname: string; reads: string; writes: string }>(
              `SELECT relname, coalesce(seq_scan, 0) + coalesce(idx_scan, 0) AS reads,
                      n_tup_ins + n_tup_upd + n_tup_del AS writes
                 FROM pg_stat_xact_user_tables
                WHERE coalesce(seq_scan, 0) + coalesce(idx_scan, 0) + n_tup_ins + n_tup_upd + n_tup_del > 0`,
            )
          ).rows.map((x) => ({
            relname: x.relname,
            reads: Number(x.reads),
            writes: Number(x.writes),
          }));
          statements.length = statements.length - 1; // not part of the write path
          return 'commit';
        },
      });
      expect(r).toEqual({ status: 'ok' });
    } finally {
      await pool.end();
    }
    const names = touched.map((t) => t.relname.replace(/_p\d+$/, ''));
    expect(names).not.toContain('documents');
    for (const t of [
      'doc_heads',
      'doc_commits',
      'doc_commit_payloads',
      'commit_scopes',
      'grant_revisions',
    ])
      expect(names).toContain(t);
    expect(statements.some((s) => /\bdocuments\b/.test(s))).toBe(false);
    // BEGIN with the tenant, the locks, one insert statement, COMMIT.
    expect(statements).toHaveLength(4);
  });

  it('stores the payload as Zstandard-compressed canonical JSON and the metadata in its own row', async () => {
    const { ref, epoch } = await newDocument(h);
    const c1 = stepCommit(1, {
      claimed: ['saliceXXXXXXXXXX'],
      scopes: [`region:${TERMS}`, 'body'],
    });
    const c2 = controlCommit(2, 1);
    expect(await h.logs.append(ref, write(epoch, [c1, c2]))).toEqual({ status: 'ok' });
    const rows = (
      await db.admin.query<{
        seq: string;
        kind: string;
        commit_id: string;
        user_id: string;
        session_id: string;
        server_ts: Date;
        origin: string;
        access_rev: string;
        cdm_version: number;
        engine: string;
        size: number;
        payload_hash: Buffer;
        prev_hash: Buffer | null;
        hash: Buffer;
        payload: Buffer;
      }>(
        `SELECT c.*, p.payload FROM doc_commits c JOIN doc_commit_payloads p USING (doc_id, seq)
          WHERE c.doc_id = $1 ORDER BY c.seq`,
        [ref.doc],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    let prev: Buffer | null = null;
    for (const [i, c] of [c1, c2].entries()) {
      const row = rows[i]!;
      // Zstandard frame magic number, then the canonical payload.
      expect(row.payload.subarray(0, 4).toString('hex')).toBe('28b52ffd');
      const json = zstdDecompressSync(row.payload).toString('utf8');
      expect(json).toBe(canonicalize({ steps: c.steps, retired: c.retired, claimed: c.claimed }));
      expect(row.size).toBe(Buffer.byteLength(json));
      expect(row.payload_hash.equals(createHash('sha256').update(json).digest())).toBe(true);
      expect({
        seq: Number(row.seq),
        kind: row.kind,
        id: row.commit_id,
        user: row.user_id,
        // A server-authored commit stores no session; it reads back as the room's sentinel.
        session: row.session_id ?? 'system',
        time: row.server_ts.getTime(),
        origin: row.origin,
        revision: Number(row.access_rev),
        cdm: row.cdm_version,
        engine: row.engine,
      }).toEqual({
        seq: c.seq,
        kind: c.kind,
        id: c.id,
        user: c.user,
        session: c.session,
        time: c.time,
        origin: c.origin,
        revision: c.revision,
        cdm: c.cdm,
        engine: c.engine,
      });
      expect(row.prev_hash === null ? null : row.prev_hash.toString('hex')).toBe(
        prev === null ? null : prev.toString('hex'),
      );
      prev = row.hash;
    }
    const [head] = (
      await db.admin.query<{ chain_head: Buffer; head_seq: string }>(
        'SELECT chain_head, head_seq FROM doc_heads WHERE doc_id = $1',
        [ref.doc],
      )
    ).rows;
    expect(Number(head!.head_seq)).toBe(2);
    expect(head!.chain_head.equals(rows[1]!.hash)).toBe(true);
  });

  it('writes scopes to commit_scopes in the same transaction, and per-scope history reads only that table', async () => {
    const { ref, epoch } = await newDocument(h);
    await h.logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2, { scopes: ['body'] })]));
    const scopes = (
      await db.admin.query<{ scope: string; seq: string }>(
        'SELECT scope, seq FROM commit_scopes WHERE doc_id = $1 ORDER BY seq, scope',
        [ref.doc],
      )
    ).rows.map((r) => `${r.seq} ${r.scope}`);
    expect(scopes).toEqual(['1 body', `1 region:${TERMS}`, '2 body']);
    const [plan] = (
      await db.admin.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) SELECT seq FROM commit_scopes
          WHERE doc_id = '${ref.doc}' AND scope = 'region:${TERMS}' ORDER BY seq`,
      )
    ).rows;
    const text = JSON.stringify(plan!['QUERY PLAN']);
    expect(text).toContain('commit_scopes');
    expect(text).not.toContain('doc_commits');
    // The log carries no index for it: only its primary key and the commit identifier.
    const indexes = (
      await db.admin.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'doc_commits' ORDER BY indexname",
      )
    ).rows.map((r) => r.indexname);
    expect(indexes).toEqual(['doc_commits_doc_id_commit_id_key', 'doc_commits_pkey']);
  });

  it('chains every commit by hash in seq order, and finds the first record altered in storage', async () => {
    const { ref, epoch } = await newDocument(h);
    const logs = h.logs as PgLogStore;
    await logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2)]));
    await logs.append(ref, write(epoch, [controlCommit(3, 1)]));
    await logs.append(ref, write(epoch, [stepCommit(4), stepCommit(5), stepCommit(6)]));
    expect(await logs.verify(ref)).toEqual({ ok: true, head: 6 });
    // The chain is the documented layout, recomputed independently from the stored row.
    const [first] = (
      await db.admin.query<{ hash: Buffer; payload_hash: Buffer }>(
        'SELECT hash, payload_hash FROM doc_commits WHERE doc_id = $1 AND seq = 1',
        [ref.doc],
      )
    ).rows;
    const [c1] = await logs.read(ref, 1, 1);
    const meta = canonicalize({
      doc: ref.doc,
      seq: 1,
      kind: 'steps',
      id: c1!.id,
      user: c1!.user,
      session: c1!.session,
      agent: null,
      time: new Date(c1!.time).toISOString(),
      origin: c1!.origin,
      scopes: [...c1!.scopes].sort(),
      base: null,
      rebased: null,
      revision: 1,
      jti: null,
      cdm: 1,
      engine: 'pm-steps/1',
      size: Buffer.byteLength(
        canonicalize({ steps: c1!.steps, retired: c1!.retired, claimed: c1!.claimed }),
      ),
    });
    const expected = createHash('sha256')
      .update(Buffer.alloc(32))
      .update(meta)
      .update(first!.payload_hash)
      .digest();
    expect(first!.hash.equals(expected)).toBe(true);
    expect(chainHash(null, Buffer.from(meta), first!.payload_hash).equals(expected)).toBe(true);
    await db.admin.query("UPDATE doc_commits SET origin = 'paste' WHERE doc_id = $1 AND seq = 4", [
      ref.doc,
    ]);
    expect(await logs.verify(ref)).toEqual({
      ok: false,
      seq: 4,
      reason: 'hash does not match the record',
    });
  });
});
