// BE-014 criterion 2 and 3 in PostgreSQL (lane U-BE-001-014): the service's database role cannot
// update or delete an audit row, the trigger refuses the statement for the schema owner too, and a
// grant change writes its audit row in the same transaction. Skipped when PostgreSQL is not up
// (infra/test-env.ps1 up).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuditEvent, PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { beginForTenant, inTenant } from '../../src/storage/db.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** SQLSTATE 42501: insufficient_privilege, which both refusals use. */
const INSUFFICIENT_PRIVILEGE = '42501';

async function rejection(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('the statement was not refused');
}

describe.skipIf(unavailable !== null)('audit_events is append-only (PostgreSQL, BE-014)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db?.drop());

  it('the service role inserts and reads its tenant events', async () => {
    const tenant = newTenant();
    const id = randomUUID();
    await inTenant(db.service, tenant, (c) =>
      insertAuditEvent(c, {
        id,
        tenant,
        doc: null,
        actor: 'system',
        kind: 'grants.changed',
        data: { rev: 1, scopes: ['doc'] },
        at: Date.now(),
      }),
    );
    const rows = await new PgAuditStore(db.service).query(tenant, { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it('the service role cannot update an audit row (the database refuses it)', async () => {
    const tenant = newTenant();
    const id = randomUUID();
    await inTenant(db.service, tenant, (c) =>
      insertAuditEvent(c, {
        id,
        tenant,
        doc: null,
        actor: 'system',
        kind: 'commit.rejected',
        data: { code: 'conflict' },
        at: Date.now(),
      }),
    );
    const client = await db.service.connect();
    try {
      await beginForTenant(client, tenant);
      const err = await rejection(
        client.query("UPDATE audit_events SET kind = 'forged' WHERE id = $1", [id]),
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const rows = await new PgAuditStore(db.service).query(tenant, { limit: 10 });
    expect(rows.map((r) => r.kind)).toEqual(['commit.rejected']);
  });

  it('the service role cannot delete an audit row (the database refuses it)', async () => {
    const tenant = newTenant();
    const id = randomUUID();
    await inTenant(db.service, tenant, (c) =>
      insertAuditEvent(c, {
        id,
        tenant,
        doc: null,
        actor: 'system',
        kind: 'commit.rejected',
        data: { code: 'conflict' },
        at: Date.now(),
      }),
    );
    const client = await db.service.connect();
    try {
      await beginForTenant(client, tenant);
      const err = await rejection(client.query('DELETE FROM audit_events WHERE id = $1', [id]));
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const rows = await new PgAuditStore(db.service).query(tenant, { limit: 10 });
    expect(rows).toHaveLength(1);
  });

  it('the schema owner is refused by the trigger too, for update and delete', async () => {
    const tenant = newTenant();
    const id = randomUUID();
    await inTenant(db.service, tenant, (c) =>
      insertAuditEvent(c, {
        id,
        tenant,
        doc: null,
        actor: 'system',
        kind: 'grants.changed',
        data: { rev: 2 },
        at: Date.now(),
      }),
    );
    const client: pg.PoolClient = await db.admin.connect();
    try {
      await beginForTenant(client, tenant);
      const upd = await rejection(
        client.query("UPDATE audit_events SET kind = 'forged' WHERE id = $1", [id]),
      );
      expect(upd.message).toContain('audit_events is append-only');
      await client.query('ROLLBACK');

      await beginForTenant(client, tenant);
      const del = await rejection(client.query('DELETE FROM audit_events WHERE id = $1', [id]));
      expect(del.message).toContain('audit_events is append-only');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
