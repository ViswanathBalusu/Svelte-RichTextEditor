// PRM-003 criteria 1 and 2 in PostgreSQL (07 §3; I3; 06 §2.3): the commit that removes a region
// retires its grants, state and lease in the transaction of the log insert, with the retiring
// `seq`; a fault inside that transaction, after the inserts and before COMMIT, leaves the grants,
// state, lease and retired list as they were and stores no commit. The memory-storage and room
// sides are src/storage/prm-003.retirement.test.ts and src/data-plane/prm-003.recovery.test.ts.
import type { PermissionState } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgLogStore } from '../../src/index.ts';
import { LEGAL, newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** The region's grants, state and lease as storage holds them. */
function regionData(p: PermissionState) {
  return {
    grants: p.grants.filter((g) => g.region === LEGAL).map((g) => g.principal),
    state: p.regionStates.get(LEGAL),
    lease: p.leases.find((l) => l.region === LEGAL)?.holder,
  };
}

const KEPT = { grants: ['group:legal', 'user:dave'], state: 'in_review', lease: 'bob' };
const GONE = { grants: [], state: undefined, lease: undefined };

describe.skipIf(unavailable !== null)('retiring a region in PostgreSQL (PRM-003)', () => {
  let db: TestDatabase;
  let h: StoreHarness;
  /** The PostgreSQL log store itself, for its transaction hooks (AppendHooks). */
  let logs: PgLogStore;
  beforeAll(async () => {
    db = await createTestDatabase();
    const s = pgStores(db.service);
    logs = s.logs;
    h = {
      tenant: newTenant(),
      otherTenant: newTenant(),
      docs: s.docs,
      logs: s.logs,
      grants: s.grants,
    };
  });
  afterAll(() => db?.drop());

  /** A document whose region Legal has grants, a state and a lease (grants revision 2). */
  async function regionWithData() {
    const { ref, epoch } = await newDocument(h);
    await h.grants.change(
      ref,
      {
        setRegionStates: [{ region: LEGAL, state: 'in_review' }],
        // A lease still valid when the test runs, so that no read could drop it as expired.
        putLeases: [{ region: LEGAL, holder: 'bob', expiresAt: Date.now() + 3_600_000 }],
      },
      { actor: 'u-owner' },
    );
    expect(regionData(await h.grants.current(ref))).toEqual(KEPT);
    return { ref, epoch };
  }

  const removal = (seq: number) =>
    stepCommit(seq, { revision: 2, retired: [LEGAL], scopes: ['body', `region:${LEGAL}`] });

  /** Rows of the region in the permission tables, read by the schema owner outside the write. */
  async function rowsOutside(doc: string): Promise<number> {
    const r = await db.admin.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM region_grants WHERE doc_id = $1 AND region_id = $2)
            + (SELECT count(*) FROM region_states WHERE doc_id = $1 AND region_id = $2)
            + (SELECT count(*) FROM region_leases WHERE doc_id = $1 AND region_id = $2) AS n`,
      [doc, LEGAL],
    );
    return Number(r.rows[0]!.n);
  }

  it('retires the grants, state and lease inside the log transaction, with the retiring seq (criterion 1)', async () => {
    const { ref, epoch } = await regionWithData();
    const c1 = stepCommit(1, { revision: 2 });
    const c2 = removal(2);
    let inside: { rows: number; outside: number; seq: string | undefined } | undefined;
    const r = await logs.append(ref, write(epoch, [c1, c2], 2), {
      beforeCommit: async (c) => {
        // Inside the transaction the rows are gone and the retirement is recorded; outside, not yet.
        const rows = await c.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM region_grants WHERE doc_id = $1 AND region_id = $2)
                + (SELECT count(*) FROM region_states WHERE doc_id = $1 AND region_id = $2)
                + (SELECT count(*) FROM region_leases WHERE doc_id = $1 AND region_id = $2) AS n`,
          [ref.doc, LEGAL],
        );
        const seq = await c.query<{ retired_seq: string }>(
          'SELECT retired_seq FROM retired_regions WHERE doc_id = $1 AND region_id = $2',
          [ref.doc, LEGAL],
        );
        inside = {
          rows: Number(rows.rows[0]!.n),
          outside: await rowsOutside(ref.doc),
          seq: seq.rows[0]?.retired_seq,
        };
        return 'commit';
      },
    });
    expect(r).toEqual({ status: 'ok' });
    expect(inside).toEqual({ rows: 0, outside: 4, seq: '2' });
    expect(regionData(await h.grants.current(ref))).toEqual(GONE);
    expect(await h.grants.retired(ref)).toEqual([LEGAL]);
    const stored = await db.admin.query<{ retired_seq: string }>(
      'SELECT retired_seq FROM retired_regions WHERE doc_id = $1 AND region_id = $2',
      [ref.doc, LEGAL],
    );
    expect(stored.rows.map((x) => Number(x.retired_seq))).toEqual([2]);
  });

  it('a fault after the inserts and before COMMIT keeps grants, state, lease and the retired list, and stores nothing (criterion 2)', async () => {
    const { ref, epoch } = await regionWithData();
    const before = await h.grants.current(ref);
    let removedInside = -1;
    const r = await logs.append(ref, write(epoch, [removal(1)], 2), {
      beforeCommit: async (c) => {
        // The transaction has already deleted the rows when the fault strikes.
        const n = await c.query<{ n: string }>(
          'SELECT count(*) AS n FROM region_grants WHERE doc_id = $1 AND region_id = $2',
          [ref.doc, LEGAL],
        );
        removedInside = Number(n.rows[0]!.n);
        return 'rollback';
      },
    });
    expect(r).toEqual({ status: 'failed' });
    expect(removedInside).toBe(0);

    expect(await h.grants.current(ref)).toEqual(before);
    expect(regionData(await h.grants.current(ref))).toEqual(KEPT);
    expect(await rowsOutside(ref.doc)).toBe(4);
    expect(await h.grants.retired(ref)).toEqual([]);
    expect(await h.logs.read(ref)).toEqual([]);
    expect((await h.logs.head(ref)).seq).toBe(0);

    // The retry, after the room resubmits, retires the region.
    expect(await h.logs.append(ref, write(epoch, [removal(1)], 2))).toEqual({ status: 'ok' });
    expect(regionData(await h.grants.current(ref))).toEqual(GONE);
    expect(await h.grants.retired(ref)).toEqual([LEGAL]);
  });

  it('the fault hook after-insert of BE-079 does the same', async () => {
    const { ref, epoch } = await regionWithData();
    const before = await h.grants.current(ref);
    const r = await h.logs.append(ref, write(epoch, [removal(1)], 2), { fault: 'after-insert' });
    expect(r).toEqual({ status: 'failed' });
    expect(await h.grants.current(ref)).toEqual(before);
    expect(await h.grants.retired(ref)).toEqual([]);
    expect(await h.logs.read(ref)).toEqual([]);
  });
});
