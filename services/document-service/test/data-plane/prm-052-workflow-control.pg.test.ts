// PRM-052 criterion 5 (lane w9): a workflow transition (the workflow becomes active, then ends) over
// the PostgreSQL stores leaves an audit entry on the `doc` scope with the new `workflowActive`, and a
// control commit at the same grants revision in the hash-chained log. The service has no workflow
// route yet (FRW): the transition is made through the grant store, the path the host's workflow
// engine will use (src/data-plane/pro-034-workflow-perm-changed.test.ts). The room writes the
// control commit when it learns of the revision (07 §9), so it runs with a real WebSocket client.
// Skips when PostgreSQL is not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
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

interface AuditRow {
  actor: string;
  doc_id: string;
  kind: string;
  data: { rev: number; scopes: string[]; workflowActive?: boolean };
  at: Date;
}

interface LogRow {
  seq: string;
  kind: string;
  prev_hash: Buffer | null;
  hash: Buffer;
}

describe.skipIf(unavailable !== null)(
  'a workflow transition over PostgreSQL: audit entry and control commit (PRM-052 criterion 5)',
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

    it('audits each transition with actor, document, doc scope and time, and chains a control commit at its revision', async () => {
      const s = pgStores(db.service);
      p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      });
      const doc = await p.createDocument();
      const alice = await p.client('alice', { [doc]: 'owner' });
      await alice.open(1, doc);

      const before = Date.now();
      const started = await p.changeGrants(doc, { workflowActive: true });
      expect(started.revision).toBe(2);
      await until(() => alice.all('perm.changed', 1).length >= 1, 3000, 'perm.changed');
      const ended = await p.changeGrants(doc, { workflowActive: false });
      expect(ended.revision).toBe(3);
      await until(() => alice.all('perm.changed', 1).length >= 2, 3000, 'second perm.changed');
      const after = Date.now();

      const audits = (
        await db.admin.query<AuditRow>(
          `SELECT actor, doc_id, kind, data, at FROM audit_events
            WHERE doc_id = $1 AND kind = 'grants.changed' ORDER BY at`,
          [doc],
        )
      ).rows;
      expect(audits.map((a) => a.data)).toEqual([
        { rev: 2, scopes: ['doc'], workflowActive: true },
        { rev: 3, scopes: ['doc'], workflowActive: false },
      ]);
      for (const a of audits) {
        expect(a.actor).toBe('alice');
        expect(a.doc_id).toBe(doc);
        expect(a.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(a.at.getTime()).toBeLessThanOrEqual(after + 1000);
      }

      // The control commits of revisions 2 and 3 are in the stored log, chained to what precedes them.
      const controlsSeen = () =>
        alice
          .all('sync.commit', 1)
          .flatMap((m) => m.d!['commits'] as Array<{ kind: string }>)
          .filter((c) => c.kind === 'control').length;
      await until(() => controlsSeen() >= 2, 3000, 'two control commits');
      const log = (
        await db.admin.query<LogRow>(
          `SELECT seq, kind, prev_hash, hash FROM doc_commits WHERE doc_id = $1 ORDER BY seq`,
          [doc],
        )
      ).rows;
      expect(log.filter((r) => r.kind === 'control')).toHaveLength(2);
      expect(log[0]!.prev_hash).toBeNull();
      for (let i = 1; i < log.length; i++)
        expect(log[i]!.prev_hash?.equals(log[i - 1]!.hash), `link at seq ${log[i]!.seq}`).toBe(
          true,
        );
      const controls = alice
        .all('sync.commit', 1)
        .flatMap((m) => m.d!['commits'] as Array<{ kind: string; control?: { rev: number } }>)
        .filter((c) => c.kind === 'control');
      expect(controls.map((c) => c.control?.rev)).toEqual([2, 3]);
    });
  },
);
