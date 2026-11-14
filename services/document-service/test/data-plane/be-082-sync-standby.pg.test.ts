// BE-082 criterion 1 (lane V-BE-071-084): with a synchronous standby for the log, losing the
// primary loses no acknowledged commit (recovery point zero for one failure).
//
// The test starts its own two PostgreSQL 17 instances in Podman, named docedit-v-be-071-084-*:
// a primary and a streaming standby, both on host networking on ports 57370 and 57371. The standby
// is made synchronous only after it streams, so the migrations are not held waiting for it. Sample
// commits are written through the data plane over a real WebSocket (PostgreSQL stores, the service
// role, no superuser on that path), each awaited to `sync.ack`. Then the primary is killed with
// SIGKILL, the standby is promoted, and the commit log read there must equal the log read from the
// primary before the kill. Both containers and the database are removed afterwards.
//
// Skips, with the reason, when the PostgreSQL image is not in the local Podman store.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { createPool, ensureServiceRole, migrate } from '../../src/index.ts';
import { pgStores, settings, SERVICE_USER } from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const IMAGE =
  'docker.io/library/postgres@sha256:748a18a54d3842d43bc156f0840d78029b8d349e0feca98c12b9c4ce3404a6b3';
const PRIMARY_PORT = 57370;
const STANDBY_PORT = 57371;
const PRIMARY = 'docedit-v-be-071-084-sync-primary';
const STANDBY = 'docedit-v-be-071-084-sync-standby';
const APP = 'docedit_v_be_071_084_standby';
const REPL_ROLE = 'docedit_repl';
const DB = `docedit_v_be_071_084_sync_${randomBytes(4).toString('hex')}`;
const WORDS = ['Failover alpha', 'Failover beta', 'Failover gamma', 'Failover delta'];

const S = settings();
const CLI = S['DOCEDIT_CONTAINER_CLI'] || 'podman';
const SERVICE_PASSWORD = S['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
// Throwaway credentials for the two containers this test starts; they are generated per run.
const SUPER_PASSWORD = randomBytes(12).toString('hex');
const REPL_PASSWORD = randomBytes(12).toString('hex');

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeout = 120_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      CLI,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function must(args: string[], timeout?: number): Promise<string> {
  const r = await run(args, timeout);
  if (r.code !== 0)
    throw new Error(
      `${CLI} ${args[0]} ${args[1] ?? ''} failed (${r.code}): ${r.stderr.trim().slice(0, 400)}`,
    );
  return r.stdout;
}

async function containerUnavailable(): Promise<string | null> {
  // The check is slow when the Podman machine is busy, so it gets a long limit.
  const r = await run(['image', 'exists', IMAGE], 5 * 60 * 1000);
  if (r.code === 0) return null;
  return `the PostgreSQL image is not in the local ${CLI} store (pull ${IMAGE})`;
}

function superClient(port: number, database = 'postgres'): pg.Client {
  return new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: SUPER_PASSWORD,
    database,
    connectionTimeoutMillis: 3000,
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  let last = '';
  for (;;) {
    try {
      if (await check()) return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > until)
      throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ''}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function removeContainers(): Promise<void> {
  for (const name of [PRIMARY, STANDBY]) await run(['rm', '-f', name], 60_000);
}

const unavailable = await containerUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'BE-082 criterion 1: synchronous standby (V-BE-071-084)',
  () => {
    let plane: Plane | undefined;
    let primaryPool: pg.Pool | undefined;
    let standbyPool: pg.Pool | undefined;
    let primary: pg.Client | undefined;

    beforeAll(
      async () => {
        await removeContainers();
      },
      5 * 60 * 1000,
    );

    afterAll(
      async () => {
        await plane?.close().catch(() => {});
        await primaryPool?.end().catch(() => {});
        await standbyPool?.end().catch(() => {});
        await primary?.end().catch(() => {});
        await removeContainers();
      },
      5 * 60 * 1000,
    );

    it(
      'loses no acknowledged commit when the primary is killed and the synchronous standby is promoted',
      async () => {
        const D = '/var/lib/postgresql/standby';

        // Primary: the image's own initdb, with WAL shipping on and no synchronous standby yet.
        await must([
          'run',
          '-d',
          '--name',
          PRIMARY,
          '--network',
          'host',
          '--cgroups=disabled',
          '-e',
          'POSTGRES_USER=postgres',
          '-e',
          `POSTGRES_PASSWORD=${SUPER_PASSWORD}`,
          '-e',
          'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
          IMAGE,
          '-c',
          'listen_addresses=127.0.0.1',
          '-c',
          `port=${PRIMARY_PORT}`,
          '-c',
          'wal_level=replica',
          '-c',
          'max_wal_senders=5',
          '-c',
          'max_replication_slots=5',
        ]);
        await waitFor('the primary to accept connections', async () => {
          const c = superClient(PRIMARY_PORT);
          try {
            await c.connect();
            await c.query('SELECT 1');
            return true;
          } catch {
            return false;
          } finally {
            await c.end().catch(() => {});
          }
        });
        primary = superClient(PRIMARY_PORT);
        await primary.connect();

        // Replication login, allowed from loopback over SCRAM; then the service role and the database.
        await primary.query(
          `CREATE ROLE ${REPL_ROLE} WITH LOGIN REPLICATION PASSWORD '${REPL_PASSWORD}'`,
        );
        await must([
          'exec',
          '-u',
          'postgres',
          PRIMARY,
          'sh',
          '-c',
          `echo 'host replication ${REPL_ROLE} 127.0.0.1/32 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf`,
        ]);
        await primary.query('SELECT pg_reload_conf()');
        await ensureServiceRole(primary, SERVICE_USER, SERVICE_PASSWORD);
        await primary.query(`CREATE DATABASE ${DB}`);
        const owner = new pg.Pool({
          host: '127.0.0.1',
          port: PRIMARY_PORT,
          user: 'postgres',
          password: SUPER_PASSWORD,
          database: DB,
          max: 4,
        });
        try {
          const c = await owner.connect();
          try {
            await migrate(c);
          } finally {
            c.release();
          }
        } finally {
          await owner.end();
        }

        // Standby: a base backup of the primary, then a hot standby on its own port.
        await must([
          'run',
          '-d',
          '--name',
          STANDBY,
          '--network',
          'host',
          '--cgroups=disabled',
          '--entrypoint',
          'sleep',
          IMAGE,
          'infinity',
        ]);
        await must([
          'exec',
          '-u',
          'root',
          STANDBY,
          'sh',
          '-c',
          `mkdir -p ${D} && chown postgres:postgres ${D} && chmod 700 ${D}`,
        ]);
        await must(
          [
            'exec',
            '-u',
            'postgres',
            '-e',
            `PGPASSWORD=${REPL_PASSWORD}`,
            STANDBY,
            'pg_basebackup',
            '-h',
            '127.0.0.1',
            '-p',
            String(PRIMARY_PORT),
            '-U',
            REPL_ROLE,
            '-D',
            D,
            '-X',
            'stream',
            '-w',
          ],
          300_000,
        );
        // Each line is passed as an argument, so the quoting of the connection string is not shell-parsed.
        const conf = [
          `port = ${STANDBY_PORT}`,
          "listen_addresses = '127.0.0.1'",
          `primary_conninfo = 'host=127.0.0.1 port=${PRIMARY_PORT} user=${REPL_ROLE} password=${REPL_PASSWORD} application_name=${APP}'`,
        ];
        await must(['exec', '-u', 'postgres', STANDBY, 'touch', `${D}/standby.signal`]);
        for (const line of conf) {
          await must([
            'exec',
            '-u',
            'postgres',
            STANDBY,
            'sh',
            '-c',
            'echo "$1" >> "$2"',
            'sh',
            line,
            `${D}/postgresql.auto.conf`,
          ]);
        }
        await must(
          [
            'exec',
            '-u',
            'postgres',
            STANDBY,
            'pg_ctl',
            '-D',
            D,
            '-l',
            '/tmp/standby.log',
            '-w',
            'start',
          ],
          180_000,
        );

        await waitFor('the standby to stream', async () => {
          const r = await primary!.query<{ state: string }>(
            'SELECT state FROM pg_stat_replication WHERE application_name = $1',
            [APP],
          );
          return r.rows[0]?.state === 'streaming';
        });

        // Only now make it synchronous: a commit waits for its flush on the standby before it is acknowledged.
        await primary.query(`ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 (${APP})'`);
        await primary.query('SELECT pg_reload_conf()');
        await waitFor('the standby to be synchronous', async () => {
          const r = await primary!.query<{ sync_state: string }>(
            'SELECT sync_state FROM pg_stat_replication WHERE application_name = $1',
            [APP],
          );
          return r.rows[0]?.sync_state === 'sync';
        });

        // Acknowledged commits: each submit must be answered with sync.ack before the next one.
        primaryPool = createPool({
          host: '127.0.0.1',
          port: PRIMARY_PORT,
          user: SERVICE_USER,
          password: SERVICE_PASSWORD,
          database: DB,
          max: 8,
        });
        const p = pgStores(primaryPool);
        plane = await startPlane({
          stores: { logs: p.logs, ownership: p.logs, grants: p.grants, documents: p.docs },
        });
        const doc = await plane.createDocument();
        const ref = plane.ref(doc);
        const alice = await plane.client('alice', { [doc]: 'owner' });
        await alice.open(1, doc);
        for (let i = 0; i < WORDS.length; i++) {
          const r = await alice.submit(1, { base: i, steps: [insertText(intro(), WORDS[i]!)] });
          expect(r.t).toBe('sync.ack');
        }
        await plane.close();
        plane = undefined;

        // What the primary holds at the moment every commit was acknowledged.
        const acked = await p.logs.read(ref, 1);
        const ackedHead = await p.logs.head(ref);
        expect(acked).toHaveLength(WORDS.length);
        await primaryPool.end();
        primaryPool = undefined;

        // Lose the primary without a clean shutdown.
        await primary.end();
        primary = undefined;
        await must(['kill', '--signal', 'KILL', PRIMARY]);

        // Promote the standby and read the log there.
        const standbyAdmin = superClient(STANDBY_PORT, DB);
        await standbyAdmin.connect();
        try {
          const promoted = await standbyAdmin.query<{ ok: boolean }>(
            'SELECT pg_promote(true, 60) AS ok',
          );
          expect(promoted.rows[0]?.ok).toBe(true);
          const rec = await standbyAdmin.query<{ r: boolean }>('SELECT pg_is_in_recovery() AS r');
          expect(rec.rows[0]?.r).toBe(false);
        } finally {
          await standbyAdmin.end();
        }

        standbyPool = createPool({
          host: '127.0.0.1',
          port: STANDBY_PORT,
          user: SERVICE_USER,
          password: SERVICE_PASSWORD,
          database: DB,
          max: 4,
        });
        const s = pgStores(standbyPool);
        const survived = await s.logs.read(ref, 1);
        const survivedHead = await s.logs.head(ref);

        // The record of the run, for the test log.
        console.log(
          JSON.stringify({
            criterion: 'U/V-BE-071-084 BE-082 criterion 1',
            date: new Date().toISOString(),
            acknowledgedCommits: acked.length,
            survivingCommits: survived.length,
            result: JSON.stringify(survived) === JSON.stringify(acked) ? 'pass' : 'fail',
          }),
        );

        expect(survived).toEqual(acked);
        expect(survivedHead).toEqual(ackedHead);
      },
      25 * 60 * 1000,
    );
  },
);
