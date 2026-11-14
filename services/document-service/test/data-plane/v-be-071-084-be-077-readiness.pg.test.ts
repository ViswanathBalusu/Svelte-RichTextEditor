// BE-077 criterion 5 over PostgreSQL (lane V-BE-071-084): when the database is unreachable, the
// readiness probe is not ready and content reads answer `unavailable`. The outage is real for the
// node: its pool points at a TCP port where nothing listens (a port this test opened and closed),
// so the connection is refused by the operating system. The shared test containers are not touched.
// When the service's own pool answers, the same probe is ready. Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/storage/db.ts';
import { readiness } from '../../src/server.ts';
import { DataPlaneError } from '../../src/data-plane/wire.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { startPlane, type Plane } from './support.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** A TCP port with nothing listening on it: the port is taken, then released. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

describe.skipIf(unavailable !== null)('BE-077 criterion 5 over PostgreSQL (V-BE-071-084)', () => {
  let db: TestDatabase;
  const extra: Array<{ end(): Promise<void> }> = [];
  let plane: Plane | null = null;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    if (plane) await plane.close();
    for (const p of extra.splice(0)) await p.end().catch(() => {});
    await db?.drop();
  });

  it('is ready while the service database answers', async () => {
    const r = await readiness(db.service);
    expect(r.ready).toBe(true);
    expect(r.schema).not.toBeNull();
  });

  it('is not ready while the database is unreachable, and says why without the connection details', async () => {
    const port = await closedPort();
    const dead = createPool({
      host: '127.0.0.1',
      port,
      user: db.serviceConfig.user,
      password: db.serviceConfig.password,
      database: db.name,
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    extra.push(dead);
    const r = await readiness(dead);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/unreachable/);
    expect(r.reason).not.toContain(String(port));
  });

  it('answers content reads with unavailable through the same unreachable database', async () => {
    const port = await closedPort();
    const dead = createPool({
      host: '127.0.0.1',
      port,
      user: db.serviceConfig.user,
      password: db.serviceConfig.password,
      database: db.name,
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    extra.push(dead);
    const s = pgStores(dead);
    const tenant = newTenant();
    plane = await startPlane({
      stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      tenant,
      node: 'node-v-be-077',
      settings: { testMode: true },
    });
    const doc = uuid7();
    const identity = plane.tokens.identity(
      plane.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }),
    );
    const err = await plane.plane.readContent(identity, doc).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DataPlaneError);
    expect((err as DataPlaneError).code).toBe('unavailable');
  });
});
