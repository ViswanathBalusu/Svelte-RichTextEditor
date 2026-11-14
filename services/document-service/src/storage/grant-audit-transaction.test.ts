/**
 * BE-014 criterion 3: a grant change and its `audit_events` row are written in one transaction.
 *
 * A fake pool records every statement with the connection it ran on, and the parameters. The
 * check is structural: the change and the audit insert run on the same connection, between BEGIN
 * and COMMIT, and when the audit insert fails the transaction is rolled back and never committed.
 * Whether PostgreSQL then drops the change itself needs a running database (postgres tests);
 * this test does not claim it.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from './db.ts';
import { PgGrantStore } from './grant-store.ts';
import type { DocRef } from './types.ts';

interface Logged {
  conn: number;
  sql: string;
  params: unknown[] | undefined;
}

function fakePool(opts: { failAudit?: boolean } = {}) {
  const log: Logged[] = [];
  let connects = 0;
  const pool = {
    connect: async () => {
      const conn = ++connects;
      return {
        query: async (sql: string, params?: unknown[]) => {
          const text = sql.replace(/\s+/g, ' ').trim();
          log.push({ conn, sql: text, params });
          if (opts.failAudit && text.startsWith('INSERT INTO audit_events')) {
            throw Object.assign(new Error('audit insert refused'), { code: '42501' });
          }
          if (/RETURNING rev/.test(text)) return { rows: [{ rev: '2' }], rowCount: 1 };
          // The state in force after the change: the head row of readPermissions.
          if (/FROM grant_revisions g JOIN documents d/.test(text))
            return {
              rows: [{ rev: '2', workflow_active: true, state: 'draft' }],
              rowCount: 1,
            };
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
    },
  };
  return { pool: pool as unknown as Pool, log, connects: () => connects };
}

const ref: DocRef = {
  tenant: '11111111-1111-4111-8111-111111111111',
  doc: '22222222-2222-4222-8222-222222222222',
};

describe('a grant change and its audit row share one transaction (BE-014 criterion 3)', () => {
  it('runs the change and the audit insert on one connection, between BEGIN and COMMIT', async () => {
    const f = fakePool();
    const store = new PgGrantStore(f.pool);
    await store.change(ref, { workflowActive: true }, { actor: 'alice' });

    expect(f.connects()).toBe(1);
    const sqls = f.log.map((l) => l.sql);
    const at = (pred: (s: string) => boolean) => sqls.findIndex(pred);
    const begin = at((s) => /^BEGIN\b/.test(s));
    const revision = at((s) => s.startsWith('UPDATE grant_revisions'));
    const audit = at((s) => s.startsWith('INSERT INTO audit_events'));
    const commit = at((s) => s === 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(revision).toBeGreaterThan(begin);
    expect(audit).toBeGreaterThan(revision);
    expect(commit).toBeGreaterThan(audit);
    expect(sqls).not.toContain('ROLLBACK');
    expect(new Set(f.log.map((l) => l.conn))).toEqual(new Set([1]));
  });

  it('rolls the change back and never commits when the audit insert fails', async () => {
    const f = fakePool({ failAudit: true });
    const store = new PgGrantStore(f.pool);
    await expect(store.change(ref, { workflowActive: true }, { actor: 'alice' })).rejects.toThrow();

    const sqls = f.log.map((l) => l.sql);
    expect(sqls.some((s) => s.startsWith('UPDATE grant_revisions'))).toBe(true);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('writes the event with tenant, document, actor, kind, scopes and server time, and no document text (criterion 4)', async () => {
    const f = fakePool();
    const store = new PgGrantStore(f.pool);
    const before = Date.now();
    await store.change(ref, { workflowActive: true }, { actor: 'alice' });
    const after = Date.now();

    const insert = f.log.find((l) => l.sql.startsWith('INSERT INTO audit_events'));
    expect(insert).toBeDefined();
    const [ids, tenants, docs, actors, kinds, data, ats] = insert!.params as [
      string[],
      string[],
      string[],
      string[],
      string[],
      string[],
      string[],
    ];
    expect(ids).toHaveLength(1);
    expect(tenants).toEqual([ref.tenant]);
    expect(docs).toEqual([ref.doc]);
    expect(actors).toEqual(['alice']);
    expect(kinds).toEqual(['grants.changed']);
    const payload = JSON.parse(data![0]!) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['rev', 'scopes']);
    expect(payload['rev']).toBe(2);
    const at = Date.parse(ats![0]!);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });
});
