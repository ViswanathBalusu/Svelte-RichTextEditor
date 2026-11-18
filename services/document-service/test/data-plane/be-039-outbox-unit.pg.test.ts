// BE-039 criterion 1 (lane w5): an operation that must change a document is written to the outbox,
// with a deterministic commit identifier, in the same transaction as the control-plane state it
// relies on. The operator's repair (BE-090) is such an operation: it writes the outbox item and the
// audit event that names the operator. Over PostgreSQL the two are one transaction (`PgOutboxWriter`),
// so a failure of either leaves neither. Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { isUuid7, uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryAudit,
  MemoryOutbox,
  MemoryOutboxWriter,
} from '../../src/data-plane/memory-ports.ts';
import { PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { PgOutbox, PgOutboxWriter } from '../../src/data-plane/pg/outbox.ts';
import { enqueueRepair, type RepairPlan } from '../../src/data-plane/repair.ts';
import type { AuditEvent, NewOutboxItem } from '../../src/storage/types.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { REQUIRES, basePermissions } from './support.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

function item(tenant: string, doc: string, commitId = uuid7()): NewOutboxItem {
  return {
    tenant,
    doc,
    commitId,
    kind: 'snapshot',
    request: { reason: 'repair', actor: 'system', preconditions: { head: 3 } },
    payload: new Uint8Array([1, 2, 3]),
  };
}

function event(tenant: string, doc: string, commit: string): AuditEvent {
  return {
    id: uuid7(),
    tenant,
    doc,
    actor: 'operator-1',
    kind: 'repair.enqueued',
    data: { commit },
    at: Date.now(),
  };
}

function plan(tenant: string, doc: string, over: Partial<RepairPlan> = {}): RepairPlan {
  return {
    ref: { tenant, doc },
    operator: 'operator-1',
    reason: 'be-039 test',
    head: 7,
    from: 5,
    currentHash: 'a'.repeat(64),
    targetHash: 'b'.repeat(64),
    changes: true,
    payload: new Uint8Array([1, 2, 3]),
    ...over,
  } as RepairPlan;
}

describe.skipIf(unavailable !== null)(
  'an outbox item and its audit event in one transaction (PostgreSQL, BE-039 criterion 1)',
  () => {
    let db: TestDatabase;
    let outbox: PgOutbox;
    let audit: PgAuditStore;
    let writer: PgOutboxWriter;

    /** A stored document: the outbox row refers to one. */
    async function document(tenant: string): Promise<string> {
      const id = uuid7();
      await pgStores(db.service).docs.create(tenant, {
        id,
        cdmVersion: 1,
        requires: REQUIRES,
        createdBy: 'alice',
        permissions: basePermissions(),
      });
      return id;
    }

    beforeAll(async () => {
      db = await createTestDatabase();
      outbox = new PgOutbox(db.service);
      audit = new PgAuditStore(db.service);
      writer = new PgOutboxWriter(db.service);
      await audit.ensurePartitions();
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('stores the item and the event together, and the same commit identifier once', async () => {
      const tenant = newTenant();
      const doc = await document(tenant);
      const it1 = item(tenant, doc);
      const [stored] = await writer.write(tenant, {
        items: [it1],
        events: [event(tenant, doc, it1.commitId)],
      });
      expect(stored).toMatchObject({ commitId: it1.commitId, state: 'pending', kind: 'snapshot' });
      expect(await outbox.get(tenant, stored!.id)).not.toBeNull();
      expect(await audit.query(tenant, { doc, limit: 10 })).toHaveLength(1);

      // The same document and commit identifier is the same item; the new event is still recorded.
      const [again] = await writer.write(tenant, {
        items: [it1],
        events: [event(tenant, doc, it1.commitId)],
      });
      expect(again!.id).toBe(stored!.id);
      expect(await outbox.claim('be-039-w5', 60_000, 100)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: stored!.id })]),
      );
    });

    it('leaves no item when the audit event is refused', async () => {
      const tenant = newTenant();
      const doc = await document(tenant);
      const it1 = item(tenant, doc);
      // An event for another tenant breaks the row policy of the audit table (BE-011).
      const foreign = event(newTenant(), doc, it1.commitId);
      await expect(writer.write(tenant, { items: [it1], events: [foreign] })).rejects.toThrow();
      expect(await outbox.claim('be-039-w5-a', 60_000, 1000)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ commitId: it1.commitId })]),
      );
      expect(await audit.query(tenant, { doc, limit: 10 })).toHaveLength(0);
    });

    it('leaves no event when the outbox item is refused', async () => {
      const tenant = newTenant();
      const doc = await document(tenant);
      const bad = { ...item(tenant, doc), kind: 'bogus' } as unknown as NewOutboxItem;
      await expect(
        writer.write(tenant, { items: [bad], events: [event(tenant, doc, bad.commitId)] }),
      ).rejects.toThrow();
      expect(await audit.query(tenant, { doc, limit: 10 })).toHaveLength(0);
    });

    it('writes a repair as one unit, with the same commit identifier for the same request', async () => {
      const tenant = newTenant();
      const doc = await document(tenant);
      const first = await enqueueRepair({ plan: plan(tenant, doc), outbox, audit, writer });
      const again = await enqueueRepair({ plan: plan(tenant, doc), outbox, audit, writer });
      expect(isUuid7(first.commitId)).toBe(true);
      expect(again.id).toBe(first.id);
      const events = await audit.query(tenant, { doc, kind: 'repair.enqueued', limit: 10 });
      expect(events.length).toBe(2);
      expect(events[0]!.data).toMatchObject({ commit: first.commitId, reason: 'be-039 test' });
      const moved = await enqueueRepair({
        plan: plan(tenant, doc, { head: 8 }),
        outbox,
        audit,
        writer,
      });
      expect(moved.commitId).not.toBe(first.commitId);
    });
  },
);

describe('an outbox item and its audit event as one unit (memory, BE-039 criterion 1)', () => {
  it('stores neither when the audit store refuses the event', async () => {
    const outbox = new MemoryOutbox();
    const audit = new MemoryAudit();
    const writer = new MemoryOutboxWriter(outbox, audit);
    audit.failing = true;
    await expect(
      enqueueRepair({ plan: plan('t1', 'doc1'), outbox, audit, writer }),
    ).rejects.toThrow('audit store');
    expect(outbox.all).toHaveLength(0);
    audit.failing = false;
    const stored = await enqueueRepair({ plan: plan('t1', 'doc1'), outbox, audit, writer });
    expect(outbox.all.map((i) => i.id)).toEqual([stored.id]);
    expect(audit.events.map((e) => e.kind)).toEqual(['repair.enqueued']);
  });
});
