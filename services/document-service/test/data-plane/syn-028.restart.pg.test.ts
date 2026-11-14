// SYN-028 criterion 6 over PostgreSQL (lane U-SYN-019-036): a room host is killed during an edit
// and a new host starts over the same PostgreSQL stores. The reconnecting client must find every
// acknowledged commit in the log, must not be ahead of the server, and the in-flight commit must be
// stored once. The memory version is services/document-service/src/data-plane/crash-recovery.test.ts;
// this file runs the same crash through the real transaction (src/storage/log-store.ts).
// Skips when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { uuid7 } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { GatedLogStore, MemoryCheckpoints, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('SYN-028 criterion 6 over PostgreSQL (U-SYN-019-036)', () => {
  let db: TestDatabase;
  const planes: Plane[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    for (const p of planes.splice(0)) await p.close();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it.each([false, true])(
    'a host killed during an edit and restarted over PostgreSQL keeps every acknowledged commit, the client is not ahead, and the in-flight commit is stored once (stored before the kill: %s)',
    async (storedBeforeKill) => {
      const s = pgStores(db.service);
      const tenant = newTenant();
      const checkpoints = new MemoryCheckpoints();
      const gate = new GatedLogStore(s.logs);
      const a = await startPlane({
        stores: { logs: gate, ownership: s.logs, grants: s.grants, documents: s.docs },
        checkpoints,
        tenant,
        node: 'node-a',
        settings: { testMode: true },
      });
      planes.push(a);
      const doc = await a.createDocument();
      const ref = a.ref(doc);
      const alice = await a.client('alice', { [doc]: 'owner' });
      const first = await alice.open(1, doc);
      const incarnation = first.d!['incarnation'] as string;

      // Acknowledged before the crash.
      const acked: string[] = [];
      for (let i = 0; i < 2; i++) {
        const id = uuid7();
        const r = await alice.submit(1, { id, base: i, steps: [insertText(intro(), `ack${i}`)] });
        expect(r.t).toBe('sync.ack');
        expect(r.d).toMatchObject({ id, seq: i + 1 });
        acked.push(id);
      }

      // The in-flight commit is held inside the persist step: sent, not answered.
      const inflight = uuid7();
      gate.hold = true;
      alice.submitNoWait(1, { id: inflight, base: 2, steps: [insertText(intro(), 'edit')] });
      await until(() => gate.pending === 1, 3000, 'the write held in flight');
      if (storedBeforeKill) await gate.release();

      // The process is killed: no checkpoint, no release of ownership.
      expect(await a.plane.hooks!.killRoom(ref)).toBe(true);
      // A write the dead host never sent to PostgreSQL stays unsent: its waiter fails with the kill.
      if (!storedBeforeKill) await gate.release(new Error('the host was killed'));
      expect((await s.logs.head(ref)).owner).toBe('node-a');
      const expectedIds = storedBeforeKill ? [...acked, inflight] : acked;
      expect((await s.logs.read(ref)).map((c) => c.id)).toEqual(expectedIds);

      // A new host on the same PostgreSQL stores; the client reconnects with a new hello.
      const b = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        checkpoints,
        tenant,
        node: 'node-b',
      });
      planes.push(b);
      const bob = await b.client('alice', { [doc]: 'owner' });
      const opened = await bob.open(1, doc, {
        resume: { seq: 2, incarnation, inflight },
      });
      expect(opened.t).toBe('ch.opened');
      const head = opened.d!['head'] as number;
      // The client has confirmed seq 2, so it is never ahead of the server.
      expect(head).toBeGreaterThanOrEqual(2);
      expect(head).toBe(expectedIds.length);
      expect(opened.d!['incarnation']).toBe(incarnation);
      expect(opened.d!['inflight']).toEqual(
        storedBeforeKill ? { state: 'accepted', seq: 3 } : { state: 'unknown' },
      );

      // The client resubmits the in-flight commit under its id; it is applied once.
      const r = await bob.submit(1, {
        id: inflight,
        base: 2,
        steps: [insertText(intro(), 'edit')],
      });
      expect(r.t).toBe('sync.ack');
      expect(r.d).toMatchObject({ id: inflight, seq: 3 });
      const again = await bob.submit(1, {
        id: inflight,
        base: 2,
        steps: [insertText(intro(), 'edit')],
      });
      expect(again.d).toMatchObject({ id: inflight, seq: 3 });

      const stored = await s.logs.read(ref);
      expect(stored.map((c) => c.id)).toEqual([...acked, inflight]);
      expect(stored.map((c) => c.seq)).toEqual([1, 2, 3]);
      expect((await s.logs.head(ref)).owner).toBe('node-b');

      // The rows themselves: one per commit, no duplicate identifier.
      const counted = await db.admin.query<{ rows: string; ids: string }>(
        'SELECT count(*)::text AS rows, count(DISTINCT commit_id)::text AS ids FROM doc_commits WHERE doc_id = $1',
        [doc],
      );
      expect(counted.rows[0]).toEqual({ rows: '3', ids: '3' });
    },
    30_000,
  );
});
