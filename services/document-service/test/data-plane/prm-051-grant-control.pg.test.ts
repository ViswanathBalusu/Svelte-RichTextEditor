// PRM-051 criterion 3 (lane U-PRM-035-051): one grant change over the PostgreSQL stores leaves an
// audit entry (actor, document, region scope, server time) and a control commit for the same
// grants revision in the hash-chained log, and a connected owner is told of it. The control commit
// is written by the room when it learns of the revision (07 §9; grant-store.ts), so the room runs
// here with a real WebSocket client. Skips when PostgreSQL is not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
//   pnpm vitest run test/data-plane/prm-051-grant-control.pg.test.ts   (in services/document-service)
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
  kind: string;
  data: { rev: number; scopes: string[] };
  at: Date;
}

interface LogRow {
  seq: string;
  kind: string;
  prev_hash: Buffer | null;
  hash: Buffer;
}

describe.skipIf(unavailable !== null)(
  'a grant change over PostgreSQL: audit entry and control commit (PRM-051 criterion 3; U-PRM-035-051)',
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

    it('audits the change with its actor, document, region scope and time, and records the control commit at the same revision in the chain', async () => {
      const s = pgStores(db.service);
      p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      });
      const doc = await p.createDocument();
      const alice = await p.client('alice', { [doc]: 'owner' });
      await alice.open(1, doc);

      const before = Date.now();
      const perms = await p.changeGrants(doc, {
        putGrants: [{ region: REGION, principal: 'user:bob', role: 'viewer', expiresAt: null }],
      });
      const after = Date.now();
      expect(perms.revision).toBe(2);

      // The room learns of the revision and tells the connected owner (perm.changed).
      await until(() => alice.all('perm.changed', 1).length >= 1, 3000, 'perm.changed');

      // The audit entry of the change (grant-store.ts, in the change's own transaction).
      const audits = (
        await db.admin.query<AuditRow>(
          `SELECT actor, doc_id, kind, data, at FROM audit_events
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

      // The control commit for revision 2 is in the stored log, as the owner's sync.commit reports it.
      const controls = alice
        .all('sync.commit', 1)
        .flatMap((m) => m.d!['commits'] as Array<{ kind: string; control?: { rev: number } }>)
        .filter((c) => c.kind === 'control');
      expect(controls.map((c) => c.control?.rev)).toEqual([2]);

      // The stored log holds exactly that control commit, and its hashes link: each commit's
      // prev_hash is the hash of the commit before it, and the first has none.
      const log = (
        await db.admin.query<LogRow>(
          `SELECT seq, kind, prev_hash, hash FROM doc_commits WHERE doc_id = $1 ORDER BY seq`,
          [doc],
        )
      ).rows;
      expect(log.filter((r) => r.kind === 'control')).toHaveLength(1);
      expect(log[0]!.prev_hash).toBeNull();
      for (let i = 1; i < log.length; i++)
        expect(log[i]!.prev_hash?.equals(log[i - 1]!.hash), `link at seq ${log[i]!.seq}`).toBe(
          true,
        );
    });
  },
);
