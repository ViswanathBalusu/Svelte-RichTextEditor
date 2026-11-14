// FRW-056 criterion 5 at the queue level, on PostgreSQL (lane U-FRW-055-072, round 5).
// "Running twice does not add two time-stamps for one expiry": a renewal job is keyed by its
// document and its expiry, and enqueued with `ifAbsent`, so the database's primary key makes a
// second enqueue for the same expiry a no-op. This proves only that mechanism. The renewal itself
// (`planRenewal` and `applyRenewalResult` in packages/authority) is not wired to this queue yet,
// so FRW-056 criterion 5 stays unticked. Each test gets a database of its own, dropped afterwards.
// The test skips when PostgreSQL is not up.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const RENEWAL_KIND = 'workflow.renewal';

/** A UUID-shaped identifier derived from the document and the expiry, so one expiry has one id. */
function renewalJobId(doc: string, expiryMs: number): string {
  const h = createHash('sha256').update(`renewal:${doc}:${expiryMs}`).digest('hex');
  const v = '5' + h.slice(13, 16);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const databases: TestDatabase[] = [];
const why = await postgresUnavailable();

describe.skipIf(why)(
  'renewal jobs are idempotent per expiry (FRW-056 criterion 5, PostgreSQL)',
  () => {
    afterAll(async () => {
      for (const db of databases) await db.drop();
    });

    it('enqueues one renewal for one expiry however often it is requested', async () => {
      const db = await createTestDatabase();
      databases.push(db);
      const q = new PgJobQueue(db.service);
      const tenant = randomUUID();
      const doc = randomUUID();
      const expiry = Date.UTC(2027, 0, 15);
      const id = renewalJobId(doc, expiry);

      const first = await q.enqueue(tenant, {
        id,
        kind: RENEWAL_KIND,
        doc,
        payload: { expiry },
        createdBy: 'system',
        ifAbsent: true,
      });
      const second = await q.enqueue(tenant, {
        id,
        kind: RENEWAL_KIND,
        doc,
        payload: { expiry },
        createdBy: 'system',
        ifAbsent: true,
      });

      expect(second.id).toBe(first.id);
      const rows = await db.admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM jobs WHERE id = $1',
        [id],
      );
      expect(rows.rows[0]?.n).toBe('1');
    });

    it('gives a later expiry of the same document its own renewal', async () => {
      const db = await createTestDatabase();
      databases.push(db);
      const q = new PgJobQueue(db.service);
      const tenant = randomUUID();
      const doc = randomUUID();
      const a = Date.UTC(2027, 0, 15);
      const b = Date.UTC(2028, 0, 15);

      for (const expiry of [a, b, a]) {
        await q.enqueue(tenant, {
          id: renewalJobId(doc, expiry),
          kind: RENEWAL_KIND,
          doc,
          payload: { expiry },
          createdBy: 'system',
          ifAbsent: true,
        });
      }
      const rows = await db.admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM jobs WHERE doc_id = $1',
        [doc],
      );
      expect(rows.rows[0]?.n).toBe('2');
    });
  },
);
