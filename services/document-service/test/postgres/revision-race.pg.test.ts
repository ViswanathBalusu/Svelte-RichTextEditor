// Grant changes racing log writes (04 G7; 06 §2.3 step 2, §3; 07 §9; BE-026). A write holds the
// revision row for share while it checks its batch's revision; a change takes it for update. So
// a write either commits before the change commits or sees the new revision and stores nothing.
// The commit order is read from PostgreSQL itself (track_commit_timestamp).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/index.ts';
import { LEGAL, newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  SERVICE_USER,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe.skipIf(unavailable !== null)('grant changes racing log writes (PostgreSQL)', () => {
  let db: TestDatabase;
  let h: StoreHarness;
  let stores: ReturnType<typeof pgStores>;
  let commitTimestamps = false;
  beforeAll(async () => {
    db = await createTestDatabase();
    stores = pgStores(db.service);
    h = { tenant: newTenant(), otherTenant: newTenant(), ...stores };
    const r = await db.admin.query<{ v: string }>(
      "SELECT current_setting('track_commit_timestamp') AS v",
    );
    commitTimestamps = r.rows[0]?.v === 'on';
  });
  afterAll(() => db?.drop());

  /**
   * Commits checked against revision `rev - 1` whose transaction did not commit before the
   * transaction that made `rev`, in PostgreSQL's commit timestamps (microseconds).
   */
  async function committedAfterChange(
    ref: DocRef,
    rev: number,
  ): Promise<{ old: number; late: number }> {
    const r = await db.admin.query<{ old: number; late: number }>(
      `SELECT count(*)::int AS old,
              count(*) FILTER (WHERE NOT pg_xact_commit_timestamp(c.xmin) < g.at)::int AS late
         FROM doc_commits c,
              (SELECT pg_xact_commit_timestamp(xmin) AS at FROM grant_history
                WHERE doc_id = $1 AND rev = $2) g
        WHERE c.doc_id = $1 AND c.access_rev = $2 - 1`,
      [ref.doc, rev],
    );
    return r.rows[0]!;
  }

  it('a write that holds the revision row makes a grant change wait until it has committed', async () => {
    const { ref, epoch } = await newDocument(h);
    let change: Promise<unknown> | null = null;
    let changeDone = false;
    const r = await stores.logs.append(ref, write(epoch, [stepCommit(1)]), {
      beforeCommit: async () => {
        change = stores.grants
          .change(
            ref,
            { removeGrants: [{ region: LEGAL, principal: 'group:legal' }] },
            { actor: 'u-owner' },
          )
          .then((x) => {
            changeDone = true;
            return x;
          });
        // The change is now queued on the revision row behind this write.
        for (let i = 0; i < 300; i++) {
          const w = await db.admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'`,
            [SERVICE_USER],
          );
          if (w.rows[0]!.n > 0) break;
          await sleep(10);
        }
        await sleep(50);
        expect(changeDone).toBe(false);
        return 'commit';
      },
    });
    expect(r).toEqual({ status: 'ok' });
    const next = (await change!) as { revision: number };
    expect(next.revision).toBe(2);
    // Stored while revision 1 was in force: the change committed after the write.
    if (commitTimestamps) expect(await committedAfterChange(ref, 2)).toEqual({ old: 1, late: 0 });
    // From now on, a batch checked against revision 1 is refused.
    const late = await stores.logs.append(ref, write(epoch, [stepCommit(2)], 1));
    expect(late.status).toBe('revision_moved');
  });

  it('once a grant change has returned, no write checked against the old revision is stored (interleaved, 20 rounds)', async () => {
    let movedSeen = 0;
    for (let round = 0; round < 20; round++) {
      const { ref, epoch } = await newDocument(h);
      let revision = 1;
      let seq = 1;
      let changeReturnedAt = Number.POSITIVE_INFINITY;
      const stored: Array<{ startedAt: number; revision: number }> = [];
      const writer = async () => {
        while (seq <= 12 || changeReturnedAt === Number.POSITIVE_INFINITY) {
          const startedAt = performance.now();
          const r = await stores.logs.append(
            ref,
            write(epoch, [stepCommit(seq, { revision })], revision),
          );
          if (r.status === 'ok') {
            stored.push({ startedAt, revision });
            seq++;
          } else if (r.status === 'revision_moved') {
            // As the room does: take the new permissions and check the next batch against them.
            movedSeen++;
            revision = r.perms.revision;
          } else throw new Error(`unexpected outcome ${r.status}`);
        }
      };
      const changer = async () => {
        await sleep(round % 7);
        await stores.grants.change(
          ref,
          {
            putGrants: [
              { region: LEGAL, principal: 'user:carol', role: 'editor', expiresAt: null },
            ],
          },
          { actor: 'u-owner' },
        );
        changeReturnedAt = performance.now();
      };
      await Promise.all([writer(), changer()]);
      // Nothing that began after the change returned was stored under revision 1.
      expect(stored.filter((s) => s.revision === 1 && s.startedAt > changeReturnedAt)).toEqual([]);
      const log = await stores.logs.read(ref);
      const revs = log.map((c) => c.revision);
      expect(revs).toEqual([...revs].sort((a, b) => a - b));
      // And in PostgreSQL's own commit order, every commit checked against revision 1 committed
      // before the change that made revision 2.
      if (commitTimestamps) expect((await committedAfterChange(ref, 2)).late).toBe(0);
    }
    expect(movedSeen).toBeGreaterThan(0);
    expect(
      commitTimestamps,
      'start PostgreSQL with track_commit_timestamp=on (infra/test-env.ps1 does)',
    ).toBe(true);
  });
});
