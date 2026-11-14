// UX-080 criterion 1, durable half (lane U-UX-076-090): tenant and document retention policies are
// stored in PostgreSQL (table `tenant_retention`, migration 0065), read back by a store that did not
// write them (a restart), versioned so that a stale write is refused, and kept apart between tenants
// by row-level security. Runs on a database of its own in the integration environment
// (infra/test-env.ps1 up), migrated as the service is; skipped with the reason when PostgreSQL is
// not reachable.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { PgRetentionStore } from '../../src/control-plane/retention-pg.ts';
import {
  KEEP_ALL,
  RetentionConflict,
  RetentionService,
} from '../../src/control-plane/retention.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const why = await postgresUnavailable();
const T1 = randomUUID();
const T2 = randomUUID();

describe.skipIf(why)('UX-080 retention store on PostgreSQL (lane U-UX-076-090)', () => {
  let db: TestDatabase;
  const doc = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('has the table from the migrations, under row-level security', async () => {
    const r = await db.admin.query<{ rls: boolean; forced: boolean }>(
      `select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
        where relname = 'tenant_retention'`,
    );
    expect(r.rows[0]).toEqual({ rls: true, forced: true });
  });

  it('stores a tenant policy and reads it back from a second store, with its version', async () => {
    const store = new PgRetentionStore(db.service);
    expect(await store.read(T1, null)).toBeNull();
    expect(await store.write(T1, null, { mode: 'thin_payloads', afterDays: 30 }, 0)).toBe(1);

    const afterRestart = new PgRetentionStore(db.service);
    expect(await afterRestart.read(T1, null)).toEqual({
      policy: { mode: 'thin_payloads', afterDays: 30 },
      version: 1,
    });
  });

  it('stores a document policy beside the tenant policy and replaces it without a second row', async () => {
    const store = new PgRetentionStore(db.service);
    expect(await store.write(T1, doc, { mode: 'keep_all' }, 0)).toBe(1);
    expect(await store.write(T1, doc, { mode: 'thin_payloads', afterDays: 7 }, 1)).toBe(2);
    expect(await store.read(T1, doc)).toEqual({
      policy: { mode: 'thin_payloads', afterDays: 7 },
      version: 2,
    });
    const rows = await db.admin.query(
      `SELECT count(*)::int AS n FROM tenant_retention WHERE tenant_id = $1 AND doc_id = $2`,
      [T1, doc],
    );
    expect(rows.rows[0]?.n).toBe(1);
    // The tenant row is untouched by the document's writes.
    expect((await store.read(T1, null))?.version).toBe(1);
  });

  it('refuses a stale write and writes nothing, so two writers that read one version cannot both succeed', async () => {
    const store = new PgRetentionStore(db.service);
    await expect(store.write(T1, null, { mode: 'keep_all' }, 0)).rejects.toThrow(RetentionConflict);
    await expect(store.write(T1, doc, { mode: 'keep_all' }, 1)).rejects.toThrow(RetentionConflict);
    expect(await store.read(T1, null)).toEqual({
      policy: { mode: 'thin_payloads', afterDays: 30 },
      version: 1,
    });
    expect((await store.read(T1, doc))?.version).toBe(2);
  });

  it('keeps tenants apart: another tenant has no policy and cannot read this one', async () => {
    const store = new PgRetentionStore(db.service);
    expect(await store.read(T2, null)).toBeNull();
    expect(await store.read(T2, doc)).toBeNull();
    expect(await store.write(T2, null, { mode: 'keep_all' }, 0)).toBe(1);
    expect((await store.read(T1, null))?.policy).toEqual({ mode: 'thin_payloads', afterDays: 30 });
    // Under T2's row-level security the service role sees T2's row only.
    const seen = await db.service.connect();
    try {
      await seen.query('BEGIN');
      await seen.query(`SELECT set_config('docedit.tenant_id', $1, true)`, [T2]);
      const r = await seen.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_retention');
      await seen.query('COMMIT');
      expect(r.rows.map((x) => x.tenant_id)).toEqual([T2]);
    } finally {
      seen.release();
    }
  });

  it('refuses a row the rules do not allow, past the code: keep_all with a period, thin_payloads without one, a zero period, version 0 and a second tenant row', async () => {
    const tenant = randomUUID();
    const bad = [
      { mode: 'keep_all', after_days: 3, version: 1 },
      { mode: 'thin_payloads', after_days: null, version: 1 },
      { mode: 'thin_payloads', after_days: 0, version: 1 },
      { mode: 'keep_all', after_days: null, version: 0 },
    ];
    for (const row of bad) {
      await expect(
        db.admin.query(
          `INSERT INTO tenant_retention (tenant_id, doc_id, mode, after_days, version) VALUES ($1, NULL, $2, $3, $4)`,
          [tenant, row.mode, row.after_days, row.version],
        ),
      ).rejects.toThrow();
    }
    await db.admin.query(
      `INSERT INTO tenant_retention (tenant_id, doc_id, mode, after_days, version) VALUES ($1, NULL, 'keep_all', NULL, 1)`,
      [tenant],
    );
    await expect(
      db.admin.query(
        `INSERT INTO tenant_retention (tenant_id, doc_id, mode, after_days, version) VALUES ($1, NULL, 'keep_all', NULL, 1)`,
        [tenant],
      ),
    ).rejects.toThrow();
  });

  it('runs the service over the store: a changed policy is audited with its previous value', async () => {
    const audit = new MemoryAudit();
    const service = new RetentionService({
      store: new PgRetentionStore(db.service),
      audit,
      documentExists: async (tenant, id) => tenant === T1 && id === doc,
      now: () => 1_700_000_000_000,
    });
    const first = await service.tenant(T2);
    expect(first).toEqual({ policy: { mode: 'keep_all' }, version: 1 });
    expect(KEEP_ALL.mode).toBe('keep_all');

    const set = await service.setTenant(T2, 'system', { mode: 'thin_payloads', afterDays: 90 }, 1);
    expect(set.previous).toEqual({ mode: 'keep_all' });
    expect(set.state).toEqual({ policy: { mode: 'thin_payloads', afterDays: 90 }, version: 2 });
    const events = await audit.query(T2, { kind: 'retention.changed', limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      scope: 'tenant',
      previous: { mode: 'keep_all' },
      policy: { mode: 'thin_payloads', afterDays: 90 },
    });

    // A document of another tenant is not found, whatever the policy.
    await expect(service.document(T2, doc)).rejects.toThrow('no such document');
    const docState = await service.document(T1, doc);
    expect(docState).toMatchObject({ source: 'document', version: 2 });
  });
});
