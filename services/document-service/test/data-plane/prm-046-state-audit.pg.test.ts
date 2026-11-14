// PRM-046 criterion 5 and PRM-052 criterion 1 (lane U-PRM-035-051): a region state change over the
// PostgreSQL stores is stored with its actor and time, is recorded as a control commit in the log,
// reaches the connected users as perm.changed (so their access is recomputed), and leaves an audit
// entry with the actor, the document, the region scope and the server time. A state change is a
// grants change that sets the state (grant-store.ts, `setRegionStates`). Skips when PostgreSQL is
// not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
//   pnpm vitest run test/data-plane/prm-046-state-audit.pg.test.ts   (in services/document-service)
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

interface AuditRow {
  actor: string;
  doc_id: string;
  data: { rev: number; scopes: string[] };
  at: Date;
}

interface StateRow {
  state: string;
  changed_by: string;
  changed_at: Date;
}

describe.skipIf(unavailable !== null)(
  'a region state change over PostgreSQL: stored, recomputed, audited (PRM-046 criterion 5; PRM-052 criterion 1; U-PRM-035-051)',
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

    it('an owner marks a region approved: the state is stored with actor and time, perm.changed is sent, and the change is audited and logged', async () => {
      const s = pgStores(db.service);
      p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      });
      const doc = await p.createDocument();
      const editor = await p.client('bob', { [doc]: 'editor' });
      const owner = await p.client('alice', { [doc]: 'owner' });
      await editor.open(1, doc);
      await owner.open(1, doc);

      const before = Date.now();
      const perms = await p.changeGrants(doc, {
        setRegionStates: [{ region: REGION, state: 'approved' }],
      });
      const after = Date.now();
      expect(perms.revision).toBe(2);
      expect(perms.regionStates.get(REGION)).toBe('approved');

      // Access is recomputed for the connected editor: the change reaches it as perm.changed.
      await until(() => editor.all('perm.changed', 1).length >= 1, 3000, 'perm.changed');

      // The state record holds the actor and the time of the change.
      const stored = (
        await db.admin.query<StateRow>(
          'SELECT state, changed_by, changed_at FROM region_states WHERE doc_id = $1 AND region_id = $2',
          [doc, REGION],
        )
      ).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.state).toBe('approved');
      expect(stored[0]!.changed_by).toBe('alice');
      expect(stored[0]!.changed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(stored[0]!.changed_at.getTime()).toBeLessThanOrEqual(after + 1000);

      // The audit trail: actor, document, region scope and server time.
      const audits = (
        await db.admin.query<AuditRow>(
          `SELECT actor, doc_id, data, at FROM audit_events
            WHERE doc_id = $1 AND kind = 'grants.changed' ORDER BY at`,
          [doc],
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actor).toBe('alice');
      expect(audits[0]!.doc_id).toBe(doc);
      expect(audits[0]!.data).toEqual({ rev: 2, scopes: [`region:${REGION}`] });
      expect(audits[0]!.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(audits[0]!.at.getTime()).toBeLessThanOrEqual(after + 1000);

      // The control commit for the state change is in the log and was sent to the owner.
      const controls = owner
        .all('sync.commit', 1)
        .flatMap((m) => m.d!['commits'] as Array<{ kind: string; control?: { rev: number } }>)
        .filter((c) => c.kind === 'control');
      expect(controls.map((c) => c.control?.rev)).toEqual([2]);
    });
  },
);
