// FRW-042 criterion 2 in PostgreSQL (lane V-FRW-019-036): a change of the network-capture setting
// is written to the audit trail with its actor and time, applies to the events after the change,
// and leaves the evidence already stored as it was. The change goes through the product path,
// `PgCaptureSettingsStore.change` (src/workflow/capture-settings-pg.ts), which writes the setting
// and its audit entry in one transaction; the evidence goes through `recordEvidence`, which applies
// the setting in force. The test builds no audit record and inserts no evidence row itself. The
// administration API that would call `change` is not built (criterion 4 stays open). Each run makes
// its own database and drops it. Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDocumentStore } from '../../src/index.ts';
import { PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { inTenant } from '../../src/storage/db.ts';
import {
  CaptureSettingsConflict,
  PgCaptureSettingsStore,
} from '../../src/workflow/capture-settings-pg.ts';
import { newTenant, postgresUnavailable } from '../support/env.ts';
import { createLaneDatabase, type LaneDatabase } from '../support/v-frw-019-036-db.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const T_BEFORE = Date.UTC(2026, 10, 10, 9, 29, 0, 0);
const T_CHANGE = Date.UTC(2026, 10, 10, 9, 30, 0, 0);
const T_AFTER = Date.UTC(2026, 10, 10, 9, 31, 0, 0);

describe.skipIf(unavailable !== null)(
  'network capture setting: audit and stored evidence (FRW-042 criterion 2, PostgreSQL)',
  () => {
    let db: LaneDatabase;
    beforeAll(async () => {
      db = await createLaneDatabase();
    });
    afterAll(() => db?.drop());

    it('audits the change with actor and time, applies it to later events only, and rewrites no stored evidence', async () => {
      const tenant = newTenant();
      const doc = await new PgDocumentStore(db.service).create(tenant, {
        cdmVersion: 1,
        createdBy: 'u',
      });
      const audit = new PgAuditStore(db.service);
      let clock = T_BEFORE;
      const settings = new PgCaptureSettingsStore(db.service, { now: () => clock });

      // The default is on, at version 0.
      expect(await settings.read(tenant)).toEqual({
        settings: { captureNetworkIdentity: true },
        version: 0,
      });

      // An event before the change: the setting is on, so the network identity is kept.
      const before = await settings.recordEvidence(tenant, {
        doc: doc.id,
        participant: 'p1',
        item: 'viewed',
        facts: { items: { step: 'viewed' }, ipAddress: '203.0.113.7', userAgent: 'Agent/1.0' },
      });
      expect(before).toEqual({
        items: { step: 'viewed' },
        ipAddress: '203.0.113.7',
        userAgent: 'Agent/1.0',
      });

      // The change: an actor turns the capture off at T_CHANGE, through the store.
      clock = T_CHANGE;
      const changed = await settings.change(
        tenant,
        'admin-surrogate-7',
        { captureNetworkIdentity: false },
        0,
      );
      expect(changed.state).toEqual({ settings: { captureNetworkIdentity: false }, version: 1 });
      expect(await settings.read(tenant)).toEqual(changed.state);

      // A stale version is refused and writes nothing; a change to the value in force is not audited.
      await expect(
        settings.change(tenant, 'admin-surrogate-8', { captureNetworkIdentity: true }, 0),
      ).rejects.toBeInstanceOf(CaptureSettingsConflict);
      expect(
        (await settings.change(tenant, 'admin-surrogate-8', { captureNetworkIdentity: false }))
          .audit,
      ).toBeNull();

      // An event after the change: the network identity is not kept, the other items are.
      clock = T_AFTER;
      const after = await settings.recordEvidence(tenant, {
        doc: doc.id,
        participant: 'p2',
        item: 'viewed',
        facts: { items: { step: 'viewed' }, ipAddress: '198.51.100.9', userAgent: 'Agent/2.0' },
      });
      expect(after).toEqual({ items: { step: 'viewed' } });

      // The change is in the audit trail once, with its actor and its time, written by the store.
      const events = await audit.query(tenant, { kind: 'capture.setting.changed', limit: 10 });
      expect(events).toHaveLength(1);
      expect(events[0]?.actor).toBe('admin-surrogate-7');
      expect(events[0]?.at).toBe(T_CHANGE);
      expect(events[0]?.doc).toBeNull();
      expect(events[0]?.data).toEqual({
        from: { captureNetworkIdentity: true },
        to: { captureNetworkIdentity: false },
        version: 1,
      });

      // The evidence stored before the change still holds the network identity, unchanged.
      const rows = await inTenant(
        db.service,
        tenant,
        (c) =>
          c.query<{ participant: string; data: Record<string, unknown>; collected_at: Date }>(
            'SELECT participant, data, collected_at FROM workflow_evidence WHERE doc_id = $1 ORDER BY collected_at',
            [doc.id],
          ),
        { readOnly: true },
      );
      expect(rows.rows.map((r) => r.participant)).toEqual(['p1', 'p2']);
      expect(rows.rows[0]?.data).toEqual(before);
      expect(rows.rows[0]?.data).toMatchObject({
        ipAddress: '203.0.113.7',
        userAgent: 'Agent/1.0',
      });
      expect(rows.rows[0]?.collected_at.getTime()).toBe(T_BEFORE);
      expect(rows.rows[1]?.data).toEqual({ items: { step: 'viewed' } });
    });

    it('refuses a change without an actor and writes neither the setting nor an audit entry', async () => {
      const tenant = newTenant();
      const settings = new PgCaptureSettingsStore(db.service, { now: () => T_CHANGE });
      // An empty actor makes `captureChangeAudit` throw inside the transaction, so it rolls back.
      await expect(settings.change(tenant, '', { captureNetworkIdentity: false })).rejects.toThrow(
        RangeError,
      );
      expect(await settings.read(tenant)).toEqual({
        settings: { captureNetworkIdentity: true },
        version: 0,
      });
      const events = await new PgAuditStore(db.service).query(tenant, {
        kind: 'capture.setting.changed',
        limit: 10,
      });
      expect(events).toHaveLength(0);
    });
  },
);
