// FRW-025 criteria 2, 3 and 5 and FRW-026 criterion 4, in PostgreSQL (lane V-FRW-019-036). The
// resource is written through the product path, `PgWorkflowResourceStore` (src/workflow/workflow-resource-pg.ts),
// on a database migrated from every migration (0070 included). The test changes the state of the
// workflow to `sent` with an UPDATE through the service role, because the `send` action is not
// built; no other row is written by hand. The HTTP route is not built, so the status codes and the
// `GET` members of criterion 1 are not tested here. Each run makes its own database and drops it.
// Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDocumentStore } from '../../src/index.ts';
import { inTenant } from '../../src/storage/db.ts';
import { PgWorkflowResourceStore } from '../../src/workflow/workflow-resource-pg.ts';
import { newTenant, postgresUnavailable } from '../support/env.ts';
import { createLaneDatabase, type LaneDatabase } from '../support/v-frw-019-036-db.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const MANAGE = { manage: true };
const NO_MANAGE = { manage: false };
const T0 = Date.UTC(2026, 10, 14, 9, 0, 0, 0);

describe.skipIf(unavailable !== null)(
  'workflow resource in PostgreSQL (FRW-025 criteria 2, 3, 5; FRW-026 criterion 4)',
  () => {
    let db: LaneDatabase;
    beforeAll(async () => {
      db = await createLaneDatabase();
    });
    afterAll(() => db?.drop());

    async function newDoc(tenant: string): Promise<string> {
      const doc = await new PgDocumentStore(db.service).create(tenant, {
        cdmVersion: 1,
        createdBy: 'u',
      });
      return doc.id;
    }

    it('keeps one workflow per document: a second create for the same document is refused (criterion 2)', async () => {
      const tenant = newTenant();
      const doc = await newDoc(tenant);
      const store = new PgWorkflowResourceStore(db.service, { now: () => T0 });
      const first = await store.create(tenant, doc, MANAGE, { timeZone: 'Europe/London' });
      expect(first.ok).toBe(true);
      const second = await store.create(tenant, doc, MANAGE, { timeZone: 'Europe/London' });
      expect(second).toEqual({ ok: false, problem: { code: 'exists' } });
      const read = await store.read(tenant, doc);
      expect(read?.id).toBe(first.ok ? first.resource.id : null);
      expect(read?.rev).toBe(1);
    });

    it('applies a PUT with the current If-Match while draft, and refuses a stale one with its revision (criterion 3)', async () => {
      const tenant = newTenant();
      const doc = await newDoc(tenant);
      const store = new PgWorkflowResourceStore(db.service, { now: () => T0 });
      await store.create(tenant, doc, MANAGE, { timeZone: 'UTC' });
      const list = [
        { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1, name: 'A' },
        { id: 'p2', roles: ['role_landlord'], kind: 'approver', order: 2 },
      ];
      const put = await store.replaceParticipants(tenant, doc, MANAGE, 1, list);
      expect(put.ok).toBe(true);
      if (!put.ok) return;
      expect(put.resource.rev).toBe(2);
      expect(put.resource.etag).toBe('"2"');
      expect(put.resource.participants).toEqual([
        { id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1, name: 'A' },
        { id: 'p2', roles: ['role_landlord'], kind: 'approver', order: 2 },
      ]);

      const stale = await store.replaceParticipants(tenant, doc, MANAGE, 1, []);
      expect(stale).toEqual({ ok: false, problem: { code: 'precondition_failed', rev: 2 } });
      expect((await store.read(tenant, doc))?.participants).toHaveLength(2);
    });

    it('refuses every PUT once the workflow is no longer draft, with workflow_active, and writes nothing', async () => {
      const tenant = newTenant();
      const doc = await newDoc(tenant);
      const store = new PgWorkflowResourceStore(db.service, { now: () => T0 });
      await store.create(tenant, doc, MANAGE, { timeZone: 'UTC' });
      // The send action is not built: the state is moved to `sent` by the service role directly.
      await inTenant(db.service, tenant, (c) =>
        c.query('UPDATE workflow_resource SET state = $3 WHERE tenant_id = $1 AND doc_id = $2', [
          tenant,
          doc,
          'sent',
        ]),
      );
      const put = await store.replaceParticipants(tenant, doc, MANAGE, 1, [
        { id: 'p1', roles: ['role_a'], kind: 'signer', order: 1 },
      ]);
      expect(put).toEqual({ ok: false, problem: { code: 'workflow_active', state: 'sent' } });
      const read = await store.read(tenant, doc);
      expect(read?.participants).toEqual([]);
      expect(read?.rev).toBe(1);
    });

    it('refuses a create and a PUT from a caller without manage with forbidden (criterion 5)', async () => {
      const tenant = newTenant();
      const doc = await newDoc(tenant);
      const store = new PgWorkflowResourceStore(db.service, { now: () => T0 });
      expect(await store.create(tenant, doc, NO_MANAGE, { timeZone: 'UTC' })).toEqual({
        ok: false,
        problem: { code: 'forbidden' },
      });
      expect(await store.read(tenant, doc)).toBeNull();

      await store.create(tenant, doc, MANAGE, { timeZone: 'UTC' });
      expect(
        await store.replaceParticipants(tenant, doc, NO_MANAGE, 1, [
          { id: 'p1', roles: ['role_a'], kind: 'signer', order: 1 },
        ]),
      ).toEqual({ ok: false, problem: { code: 'forbidden' } });
      expect((await store.read(tenant, doc))?.rev).toBe(1);
    });

    it('stores no contact detail and refuses a participant that carries one, or an unknown kind (FRW-026 criterion 4)', async () => {
      const columns = await db.service.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'workflow_resource'`,
      );
      const names = columns.rows.map((r) => r.column_name);
      expect(names.some((n) => /mail|phone|tel|address/i.test(n))).toBe(false);

      const tenant = newTenant();
      const doc = await newDoc(tenant);
      const store = new PgWorkflowResourceStore(db.service, { now: () => T0 });
      await store.create(tenant, doc, MANAGE, { timeZone: 'UTC' });
      const withEmail = await store.replaceParticipants(tenant, doc, MANAGE, 1, [
        { id: 'p1', roles: ['role_a'], kind: 'signer', order: 1, email: 'a@example.test' },
      ]);
      expect(withEmail.ok).toBe(false);
      if (!withEmail.ok && withEmail.problem.code === 'invalid_participants') {
        expect(withEmail.problem.problems).toEqual([
          { index: 0, member: 'email', reason: 'unknown_member' },
        ]);
      } else {
        throw new Error('a contact member must be refused');
      }
      const badKind = await store.replaceParticipants(tenant, doc, MANAGE, 1, [
        { id: 'p1', roles: ['role_a'], kind: 'viewer', order: 1 },
      ]);
      expect(badKind.ok).toBe(false);
      expect((await store.read(tenant, doc))?.rev).toBe(1);
    });
  },
);
