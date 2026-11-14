// Fencing with the ownership epoch and the primary key (06 §2.1, §8; BE-017), with real rooms:
// a node that lost ownership cannot append and stops serving; two nodes that both believe they
// own a document cannot both store the same seq.
import type { WriteRequest, WriteResult } from '@docedit/authority';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/index.ts';
import { stepCommit, write } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  SERVICE_USER,
  type TestDatabase,
} from '../support/env.ts';
import { basePermissions, messages, openRoom, typing, USERS } from '../support/room.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('fencing (PostgreSQL)', () => {
  let db: TestDatabase;
  let stores: ReturnType<typeof pgStores>;
  const tenant = newTenant();
  beforeAll(async () => {
    db = await createTestDatabase();
    stores = pgStores(db.service);
  });
  afterAll(() => db?.drop());

  async function newDoc(): Promise<{ ref: DocRef; incarnation: string }> {
    const rec = await stores.docs.create(tenant, {
      cdmVersion: 1,
      requires: ['fields'],
      createdBy: 'u',
      permissions: basePermissions(),
    });
    return { ref: { tenant, doc: rec.id }, incarnation: rec.incarnation };
  }

  /** Holds the head row until the returned function is called, so that writers queue on it. */
  async function holdHead(
    ref: DocRef,
  ): Promise<{ client: pg.PoolClient; release(): Promise<void> }> {
    const client = await db.admin.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM doc_heads WHERE doc_id = $1 FOR UPDATE', [ref.doc]);
    return {
      client,
      async release() {
        await client.query('COMMIT');
        client.release();
      },
    };
  }

  async function waitForLockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const r = await db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'`,
        [SERVICE_USER],
      );
      if (r.rows[0]!.n >= n) return;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`fewer than ${n} writers waiting on the head row`);
  }

  it('a node that lost ownership cannot append; its room stops and closes its channels', async () => {
    const { ref, incarnation } = await newDoc();
    const epochA = await stores.logs.claim(ref, 'node-a');
    const roomA = openRoom({ log: [], epoch: epochA, incarnation });
    roomA.open('a1', USERS.alice);
    const epochB = await stores.logs.claim(ref, 'node-b');
    expect(epochB).toBe(epochA + 1);
    const roomB = openRoom({ log: await stores.logs.read(ref), epoch: epochB, incarnation });
    roomB.open('b1', USERS.alice);

    const wa = roomA.submit('a1', typing(0, 'stale')).write!;
    const ra = await stores.logs.append(ref, wa);
    expect(ra).toEqual({ status: 'fenced' });
    const fx = roomA.writeCompleted(ra);
    expect(roomA.isStopped).toBe(true);
    expect(messages(fx)).toEqual([{ t: 'ch.closed', code: 'unavailable', reason: 'fenced' }]);
    expect(await stores.logs.read(ref)).toEqual([]);

    const cb = typing(0, 'owner');
    const wb = roomB.submit('b1', cb).write!;
    expect(await stores.logs.append(ref, wb)).toEqual({ status: 'ok' });
    const ack = messages(roomB.writeCompleted({ status: 'ok' }));
    expect(ack).toMatchObject([{ t: 'sync.ack', id: cb.id, seq: 1 }]);
    expect((await stores.logs.read(ref)).map((c) => c.id)).toEqual([cb.id]);
  });

  it('two nodes that both believe they own a document append the same seq at once: one is stored, the other stops', async () => {
    const { ref, incarnation } = await newDoc();
    const epoch = await stores.logs.claim(ref, 'node-a');
    // A split brain: both rooms hold the same epoch.
    const rooms = [
      openRoom({ log: [], epoch, incarnation }),
      openRoom({ log: [], epoch, incarnation }),
    ];
    const inputs = [typing(0, 'one'), typing(0, 'two')];
    const writes: WriteRequest[] = rooms.map((room, i) => {
      room.open(`c${i}`, USERS.alice);
      return room.submit(`c${i}`, inputs[i]!).write!;
    });
    expect(writes.map((w) => w.fromSeq)).toEqual([1, 1]);

    const hold = await holdHead(ref);
    const pending = writes.map((w) => stores.logs.append(ref, w));
    await waitForLockWaiters(2);
    await hold.release();
    const results: WriteResult[] = await Promise.all(pending);

    expect(results.map((r) => r.status).sort()).toEqual(['fenced', 'ok']);
    const winner = results.findIndex((r) => r.status === 'ok');
    const loser = 1 - winner;
    rooms[winner]!.writeCompleted(results[winner]!);
    const fx = rooms[loser]!.writeCompleted(results[loser]!);
    expect(rooms[winner]!.isStopped).toBe(false);
    expect(rooms[loser]!.isStopped).toBe(true);
    expect(messages(fx)).toEqual([{ t: 'ch.closed', code: 'unavailable', reason: 'fenced' }]);
    expect((await stores.logs.read(ref)).map((c) => c.id)).toEqual([inputs[winner]!.id]);
  });

  it('the primary key refuses a second commit at a stored seq even when the head check is passed', async () => {
    const { ref } = await newDoc();
    const epoch = await stores.logs.claim(ref, 'node-a');
    const c1 = stepCommit(1);
    expect(await stores.logs.append(ref, write(epoch, [c1]))).toEqual({ status: 'ok' });
    // A head row that lies: as if a writer had skipped the head check.
    await db.admin.query('UPDATE doc_heads SET head_seq = 0, chain_head = NULL WHERE doc_id = $1', [
      ref.doc,
    ]);
    expect(await stores.logs.append(ref, write(epoch, [stepCommit(1)]))).toEqual({
      status: 'fenced',
    });
    expect((await stores.logs.read(ref)).map((c) => c.id)).toEqual([c1.id]);
  });
});
