/**
 * SEC-056 criterion 3 against PostgreSQL (10 §4; 08 §13; HIS-038): after a user is erased, the log
 * still verifies. Lane U-SEC-049-064.
 *
 * The mapping from the host `sub` to the surrogate is held by PgUserDirectory in a database of its
 * own (createTestDatabase names it docedit_sec_<random>; it is dropped afterwards). The log is the
 * bundle of packages/history: its commits name the surrogate, never the `sub`, and erasure deletes
 * only the mapping row (HIS-038), so the log is not changed by erasure. The test builds a log of
 * commits authored under the surrogate, verifies it, erases the user in PostgreSQL, and verifies
 * it again. The log is built in memory for the test; it is not read back from the document service.
 *
 * The PostgreSQL case skips when the shared container is not reachable, with the reason, as the
 * other PostgreSQL cases do.
 *
 * Run: pnpm vitest run tests/security/test/sec-056-erasure-chain-postgres.test.ts
 * (with infra/test-env.ps1 up -NoExport).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgUserDirectory } from '../../../services/document-service/src/control-plane/users.ts';
import {
  BUNDLE_FORMAT,
  chainHash,
  payloadDigest,
  shownAuthor,
  verifyBundle,
  type BundleCommit,
  type ChainMetadata,
  type LogBundle,
} from '../../../packages/history/src/index.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from './support/harness.ts';

const skip = await postgresUnavailable();

function metaFor(doc: string, seq: number, user: string, size: number): ChainMetadata {
  return {
    doc,
    seq,
    kind: 'commit',
    id: `c-${seq}`,
    user,
    session: null,
    agent: null,
    time: '2026-11-13T09:00:00.000Z',
    origin: 'client',
    scopes: ['edit'],
    base: seq - 1,
    rebased: false,
    revision: 1,
    jti: null,
    cdm: 1,
    engine: 'engine-1',
    size,
  };
}

/** A valid log of `n` commits, every one authored by `user`, built as the stored chain is (ADR 0020). */
async function buildLog(doc: string, user: string, n: number): Promise<LogBundle> {
  const commits: BundleCommit[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const payload = {
      steps: [{ stepType: 'insert', text: `text-${seq}` }],
      retired: [],
      claimed: [],
    };
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = metaFor(doc, seq, user, size);
    const hash = await chainHash(prev, meta, payloadHash);
    commits.push({ meta, payloadHash, prevHash: prev, hash, payload });
    prev = hash;
  }
  return { format: BUNDLE_FORMAT, doc, head: { seq: n, chainHead: prev }, commits };
}

describe.skipIf(skip !== null)('SEC-056 criterion 3 PostgreSQL (U-SEC-049-064)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let users: PgUserDirectory;

  beforeAll(async () => {
    if (skip) return;
    db = await createTestDatabase();
    pool = new pg.Pool({ connectionString: db.url, max: 2 });
    pool.on('error', () => {});
    users = new PgUserDirectory(pool);
  });

  afterAll(async () => {
    if (skip) return;
    await pool?.end().catch(() => {});
    await db?.drop();
  });

  async function tenant(): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      'INSERT INTO tenants (id, tenant_id, name, created_at) VALUES ($1, $1, $2, now())',
      [id, 'U-SEC-049-064 tenant'],
    );
    return id;
  }

  it('the log verifies before and after the user is erased, and the sub is in no log byte', async () => {
    const t = await tenant();
    const sub = `erase.chain+${randomUUID()}@example.test`;
    const name = 'Erase Chain Person';
    const { surrogate } = await users.resolve(t, sub, name);
    const doc = `doc-U-SEC-049-064-${randomUUID()}`;
    const log = await buildLog(doc, surrogate, 4);

    const before = await verifyBundle(log);
    expect(before.status).toBe('intact');
    expect(before.commits).toBe(4);

    expect(await users.erase(t, sub)).toBe(true);
    expect(await users.displayName(t, sub)).toBeNull();

    const after = await verifyBundle(log);
    expect(after.status).toBe('intact');
    expect(after.head).toBe(before.head);
    expect(after.commits).toBe(before.commits);
    expect(after.problems).toEqual([]);

    // The log holds the surrogate only: neither the sub nor the name is in it.
    const text = JSON.stringify(log);
    expect(text.includes(sub)).toBe(false);
    expect(text.includes(name)).toBe(false);
    expect(text.includes(surrogate)).toBe(true);

    // The label of an erased author is an unknown person, with no name and no sub.
    const label = shownAuthor({ user: surrogate }, new Set([surrogate]));
    expect(JSON.stringify(label)).not.toContain(sub);
    expect(label).toEqual({ kind: 'unknown' });
  });
});
