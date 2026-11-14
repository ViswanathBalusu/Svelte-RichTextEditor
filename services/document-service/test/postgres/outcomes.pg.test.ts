// Failed and unknown writes with real connection failures (04 §5 "When a write fails"; 06 §2.3,
// §8; BE-025): a session ended before COMMIT is a definite failure; while COMMIT is outstanding,
// or when its answer is lost, the store waits until the transaction has ended and reads the log
// back, and the room acknowledges exactly what was stored.
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, PgGrantStore, PgLogStore, type DocRef } from '../../src/index.ts';
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

/**
 * A TCP relay to PostgreSQL that, when armed, forwards the next COMMIT and then drops the
 * client's side before the answer arrives: the server commits, the client never hears.
 */
class LossyRelay {
  readonly server: net.Server;
  armed = false;
  dropped = 0;

  constructor(target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(target.port, target.host);
      let cut = false;
      client.on('data', (chunk) => {
        if (this.armed && chunk.includes('COMMIT\u0000')) {
          this.armed = false;
          cut = true;
          this.dropped++;
          upstream.write(chunk, () => client.destroy());
          return;
        }
        upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (cut) upstream.destroy();
        else client.write(chunk);
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => {
        if (!cut) upstream.destroy();
      });
      upstream.on('close', () => client.destroy());
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () =>
        resolve((this.server.address() as net.AddressInfo).port),
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe.skipIf(unavailable !== null)('failed and unknown writes (PostgreSQL)', () => {
  let db: TestDatabase;
  let stores: ReturnType<typeof pgStores>;
  const tenant = newTenant();
  beforeAll(async () => {
    db = await createTestDatabase();
    stores = pgStores(db.service);
  });
  afterAll(() => db?.drop());

  async function newDoc() {
    const rec = await stores.docs.create(tenant, {
      cdmVersion: 1,
      requires: ['fields'],
      createdBy: 'u',
      permissions: basePermissions(),
    });
    const ref: DocRef = { tenant, doc: rec.id };
    const epoch = await stores.logs.claim(ref, 'node-a');
    const room = openRoom({ log: [], epoch, incarnation: rec.incarnation });
    room.open('ch', USERS.alice);
    return { ref, room };
  }

  /** The pid of the service session whose current statement matches, once it shows up. */
  async function sessionPid(where: string): Promise<number> {
    for (let i = 0; i < 500; i++) {
      const r = await db.admin.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND usename = $1 AND ${where}`,
        [SERVICE_USER],
      );
      if (r.rows[0]) return r.rows[0].pid;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`no session where ${where}`);
  }

  it('a session ended before COMMIT stores nothing; the room rejects the commit for resubmission', async () => {
    const { ref, room } = await newDoc();
    const input = typing(0);
    const w = room.submit('ch', input).write!;
    // Hold the head row, so that the write waits; then end the write's session.
    const hold = await db.admin.connect();
    await hold.query('BEGIN');
    await hold.query('SELECT 1 FROM doc_heads WHERE doc_id = $1 FOR UPDATE', [ref.doc]);
    const pending = stores.logs.append(ref, w);
    const pid = await sessionPid("wait_event_type = 'Lock'");
    await db.admin.query('SELECT pg_terminate_backend($1)', [pid]);
    const result = await pending;
    await hold.query('COMMIT');
    hold.release();
    expect(result).toEqual({ status: 'failed' });
    expect(await stores.logs.read(ref)).toEqual([]);
    expect(messages(room.writeCompleted(result))).toMatchObject([
      { t: 'sync.reject', id: input.id, code: 'unavailable', action: 'retry' },
    ]);
  });

  it('a session ended while COMMIT is outstanding: the log is read back and shows nothing stored', async () => {
    const { ref, room } = await newDoc();
    // A deferred trigger that sleeps at COMMIT for this document only.
    await db.admin.query(`
      CREATE OR REPLACE FUNCTION test_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF new.doc_id = '${ref.doc}'::uuid THEN PERFORM pg_sleep(5); END IF;
        RETURN NULL;
      END $$;
      DROP TRIGGER IF EXISTS test_slow_commit ON doc_heads;
      CREATE CONSTRAINT TRIGGER test_slow_commit AFTER UPDATE ON doc_heads
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_slow_commit();`);
    try {
      const input = typing(0);
      const w = room.submit('ch', input).write!;
      const pending = stores.logs.append(ref, w);
      const pid = await sessionPid("query = 'COMMIT' AND wait_event = 'PgSleep'");
      await db.admin.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await pending;
      expect(result).toEqual({ status: 'unknown', tail: [] });
      expect(await stores.logs.read(ref)).toEqual([]);
      expect(messages(room.writeCompleted(result))).toMatchObject([
        { t: 'sync.reject', id: input.id, code: 'unavailable', action: 'retry' },
      ]);
    } finally {
      await db.admin.query('DROP TRIGGER IF EXISTS test_slow_commit ON doc_heads');
    }
  });

  it('the answer to COMMIT is lost after the commit: the log is read back and the room acknowledges what was stored', async () => {
    const { ref, room } = await newDoc();
    const relay = new LossyRelay({
      host: String(db.serviceConfig.host),
      port: Number(db.serviceConfig.port),
    });
    const port = await relay.listen();
    const pool = createPool({ ...db.serviceConfig, host: '127.0.0.1', port, max: 3 });
    try {
      const grants = new PgGrantStore(pool);
      const logs = new PgLogStore(pool, { permissions: (r) => grants.current(r) });
      const input = typing(0);
      const w = room.submit('ch', input).write!;
      relay.armed = true;
      const result = await logs.append(ref, w);
      expect(relay.dropped).toBe(1);
      expect(result.status).toBe('unknown');
      const stored = await stores.logs.read(ref);
      expect(stored.map((c) => c.id)).toEqual([input.id]);
      expect(result).toEqual({ status: 'unknown', tail: stored });
      expect(messages(room.writeCompleted(result))).toMatchObject([
        { t: 'sync.ack', id: input.id, seq: 1 },
      ]);
      expect(room.head).toBe(1);
    } finally {
      await pool.end();
      await relay.close();
    }
  });

  it('reports a failed write, not an exception, when PostgreSQL cannot be reached', async () => {
    const { ref, room } = await newDoc();
    const pool = createPool({
      ...db.serviceConfig,
      host: '127.0.0.1',
      port: 9, // discard: nothing listens
      connectionTimeoutMillis: 500,
    });
    try {
      const grants = new PgGrantStore(pool);
      const logs = new PgLogStore(pool, { permissions: (r) => grants.current(r) });
      const input = typing(0);
      const result = await logs.append(ref, room.submit('ch', input).write!);
      expect(result).toEqual({ status: 'failed' });
      expect(messages(room.writeCompleted(result))).toMatchObject([
        { t: 'sync.reject', id: input.id, code: 'unavailable' },
      ]);
    } finally {
      await pool.end();
    }
  });
});
