/**
 * SEC-029 criterion 1 (lane U-SEC-017-032): a stored log edited directly in PostgreSQL is reported
 * by the chain verifier, which names the first broken `seq` (10 §3.3; 08 §2, §12; BE-081).
 *
 * The rows are changed as the PostgreSQL superuser, which bypasses row-level security. That is the
 * operator's own access (10 §2), so this shows what the verifier reports when the operator tampers;
 * the service role has no update or delete on the log. Each case uses its own document, in a
 * database created for this file and dropped afterwards.
 *
 * The verifier is PgLogStore.verify (services/document-service/src/storage/log-store.ts), the chain
 * check the store runs over the stored metadata and payload hashes. Its verdict names the first
 * record that does not verify. A deleted record is seen as a gap at the record after it, so that
 * record is the one named.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { PgLogStore } from '../../../services/document-service/src/storage/log-store.ts';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const skip = await postgresUnavailable(); // null when PostgreSQL answers (SEC harness skip pattern)
const COMMITS = 5;
/** The record every case touches; records before it and after it stay as they were stored. */
const TARGET = 3;

type Stmt = [string, unknown[]];

interface TamperCase {
  name: string;
  /** The seq the verifier must report as the first broken record. */
  expectSeq: number;
  /** Statements for a document; `$1` is the document and `$2` the target seq. */
  sql: Stmt[];
}

const DOC_TABLES = ['doc_commits', 'doc_commit_payloads', 'commit_scopes'] as const;

const cases: TamperCase[] = [
  {
    name: 'an edited user on a commit row',
    expectSeq: TARGET,
    sql: [['UPDATE doc_commits SET user_id = $3 WHERE doc_id = $1 AND seq = $2', ['mallory']]],
  },
  {
    name: 'an edited origin on a commit row',
    expectSeq: TARGET,
    sql: [['UPDATE doc_commits SET origin = $3 WHERE doc_id = $1 AND seq = $2', ['restore']]],
  },
  {
    name: 'an edited server time on a commit row',
    expectSeq: TARGET,
    sql: [
      [
        "UPDATE doc_commits SET server_ts = server_ts + interval '1 second' WHERE doc_id = $1 AND seq = $2",
        [],
      ],
    ],
  },
  {
    name: 'an edited access revision on a commit row',
    expectSeq: TARGET,
    sql: [
      ['UPDATE doc_commits SET access_rev = access_rev + 1 WHERE doc_id = $1 AND seq = $2', []],
    ],
  },
  {
    name: 'an edited scope of a commit',
    expectSeq: TARGET,
    sql: [["UPDATE commit_scopes SET scope = scope || '-x' WHERE doc_id = $1 AND seq = $2", []]],
  },
  {
    name: 'a deleted commit, with its payload and scopes',
    expectSeq: TARGET + 1,
    sql: [
      ['DELETE FROM commit_scopes WHERE doc_id = $1 AND seq = $2', []],
      ['DELETE FROM doc_commit_payloads WHERE doc_id = $1 AND seq = $2', []],
      ['DELETE FROM doc_commits WHERE doc_id = $1 AND seq = $2', []],
    ],
  },
  {
    name: 'an inserted record at the target seq, later records shifted up',
    expectSeq: TARGET,
    sql: [
      // Move the target and every later record out of the way, then back up by one.
      ...DOC_TABLES.map((t): Stmt => [
        `UPDATE ${t} SET seq = seq + 1000 WHERE doc_id = $1 AND seq >= $2`,
        [],
      ]),
      ...DOC_TABLES.map((t): Stmt => [
        `UPDATE ${t} SET seq = seq - 999 WHERE doc_id = $1 AND seq >= $2 + 1000`,
        [],
      ]),
      // The forged record: a copy of the one before, with a new identifier and a made-up hash.
      [
        `INSERT INTO doc_commits
           SELECT doc_id, $2::bigint, tenant_id, kind, gen_random_uuid(), user_id, session_id, agent,
                  server_ts, origin, base, rebased, access_rev, token_jti, cdm_version, engine,
                  size, payload_hash, prev_hash, sha256(convert_to('forged', 'UTF8'))
             FROM doc_commits WHERE doc_id = $1 AND seq = $2 - 1`,
        [],
      ],
    ],
  },
  {
    name: 'two records reordered',
    expectSeq: TARGET,
    sql: DOC_TABLES.flatMap((t): Stmt[] => [
      [`UPDATE ${t} SET seq = 100000 WHERE doc_id = $1 AND seq = $2`, []],
      [`UPDATE ${t} SET seq = $2::bigint WHERE doc_id = $1 AND seq = $2 + 1`, []],
      [`UPDATE ${t} SET seq = $2::bigint + 1 WHERE doc_id = $1 AND seq = 100000`, []],
    ]),
  },
];

describe('SEC-029 direct edits to the stored log are detected (postgres)', () => {
  let h: Harness;
  let store: PgLogStore;

  beforeAll(async () => {
    if (skip) return;
    h = await startHarness('postgres');
    store = h.parts.logs as unknown as PgLogStore;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  const t = () => (skip ? it.skip : it);

  /** A document with COMMITS commits, submitted over the wire by an editor. */
  async function seed(): Promise<string> {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const ref = { tenant: h.a.id, doc };
    const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      await c.hello(token);
      await c.open(1, doc);
      const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json;
      const pos = posInside(content.doc, 'pIntro0000000001');
      for (let i = 0; i < COMMITS; i++) {
        const base = (await h.parts.logs.head(ref)).seq;
        const ack = await c.submit(1, { id: uuid7(), base, steps: [insertText(pos, `t${i}`)] });
        expect(ack.t).toBe('sync.ack');
      }
    } finally {
      c.terminate();
    }
    return doc;
  }

  /** Runs the statements as the superuser in one transaction, with foreign key triggers off. */
  async function tamper(doc: string, statements: Stmt[]): Promise<void> {
    const client = await h.db!.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      for (const [sql, extra] of statements) {
        // $1 is the document and $2 the target seq; extra values follow as $3 onwards.
        await client.query(sql, [doc, TARGET, ...extra]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  t()(
    'the untampered log verifies (the control for every case below)',
    async () => {
      const doc = await seed();
      const v = await store.verify({ tenant: h.a.id, doc });
      expect(v.ok).toBe(true);
    },
    60_000,
  );

  for (const c of cases) {
    t()(
      `${c.name} is reported at the first broken seq`,
      async () => {
        const doc = await seed();
        const target = await h.db!.admin.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM doc_commits WHERE doc_id = $1 AND seq = $2',
          [doc, TARGET],
        );
        expect(Number(target.rows[0]!.n)).toBe(1);
        const scopes = await h.db!.admin.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM commit_scopes WHERE doc_id = $1 AND seq = $2',
          [doc, TARGET],
        );
        expect(Number(scopes.rows[0]!.n)).toBeGreaterThan(0); // the commit has scopes to change

        const before = await store.verify({ tenant: h.a.id, doc });
        expect(before.ok).toBe(true);

        await tamper(doc, c.sql);
        const after = await store.verify({ tenant: h.a.id, doc });
        expect(after.ok).toBe(false);
        if (!after.ok) expect(after.seq).toBe(c.expectSeq);
      },
      60_000,
    );
  }
});
