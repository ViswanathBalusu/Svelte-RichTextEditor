// PRM-045 criterion 3 (lane U-PRM-035-051): breaking another person's lease over the PostgreSQL
// stores commits a control commit to the log and leaves an audit entry with the actor, the document,
// the region scope and the server time. A break is a grants change that removes the lease (the
// lease routes of the control plane store it that way, lease-routes.ts), so this test makes the same
// change through the plane and reads both records back. Skips when PostgreSQL is not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
//   pnpm vitest run test/data-plane/prm-045-lease-break.pg.test.ts   (in services/document-service)
import { uuid7 } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { startPlane, until, type Plane } from './support.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const REGION = 'rNotes000000000C';
const LEASE_MS = 5 * 60 * 1000;

interface AuditRow {
  actor: string;
  doc_id: string;
  data: { rev: number; scopes: string[] };
  at: Date;
}

describe.skipIf(unavailable !== null)(
  'breaking a lease over PostgreSQL: control commit and audit entry (PRM-045 criterion 3; U-PRM-035-051)',
  () => {
    let db: TestDatabase;
    let p: Plane | undefined;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });
    afterEach(async () => {
      await p?.close();
      p = undefined;
    });

    it('a manager breaks the lease: the lease ends for the holder, and the break is a control commit and an audit entry', async () => {
      const s = pgStores(db.service);
      p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      });
      const doc = await p.createDocument();
      const holder = await p.client('bob', { [doc]: 'editor' });
      const manager = await p.client('alice', { [doc]: 'owner' });
      await holder.open(1, doc);
      await manager.open(1, doc);

      // The holder takes the lease (revision 2): the lease is stored as a grants change.
      const leased = await p.changeGrants(doc, {
        putLeases: [
          {
            region: REGION,
            holder: 'bob',
            expiresAt: Date.now() + LEASE_MS,
            id: uuid7(),
            acquiredAt: Date.now(),
          },
        ],
      });
      expect(leased.revision).toBe(2);
      expect(leased.leases.map((l) => l.region)).toEqual([REGION]);
      await until(() => holder.all('perm.changed', 1).length >= 1, 3000, 'perm.changed (lease)');

      // The manager breaks it (revision 3): the lease is removed for everyone.
      const before = Date.now();
      const broken = await p.changeGrants(doc, { removeLeases: [REGION] });
      const after = Date.now();
      expect(broken.revision).toBe(3);
      expect(broken.leases).toEqual([]);
      await until(() => holder.all('perm.changed', 1).length >= 2, 3000, 'perm.changed (break)');

      // The audit trail holds the break: the manager as actor, the document, the region scope, the time.
      const audits = (
        await db.admin.query<AuditRow>(
          `SELECT actor, doc_id, data, at FROM audit_events
            WHERE doc_id = $1 AND kind = 'grants.changed' ORDER BY at`,
          [doc],
        )
      ).rows;
      expect(audits.map((a) => a.data.rev)).toEqual([2, 3]);
      const last = audits[1]!;
      expect(last.actor).toBe('alice');
      expect(last.doc_id).toBe(doc);
      expect(last.data).toEqual({ rev: 3, scopes: [`region:${REGION}`] });
      expect(last.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(last.at.getTime()).toBeLessThanOrEqual(after + 1000);

      // The control commit for the break is in the log and was sent to the connected users.
      const controls = manager
        .all('sync.commit', 1)
        .flatMap((m) => m.d!['commits'] as Array<{ kind: string; control?: { rev: number } }>)
        .filter((c) => c.kind === 'control');
      expect(controls.map((c) => c.control?.rev)).toEqual([2, 3]);
    });
  },
);
