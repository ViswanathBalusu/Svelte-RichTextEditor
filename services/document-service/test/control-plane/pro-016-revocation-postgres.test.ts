// Durable session revocation in PostgreSQL (PRO-016 criteria 1 and 3; BE-031; 05 §3.3; lane U-PRO-001-017).
// The watermark is written to tenant_users and document_revocations, so a revoked token stays refused
// after the directory is rebuilt over the same database (a restart). The test database is created and
// dropped by the shared harness (test/support/env.ts); it is skipped when PostgreSQL is not up.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signJws } from '../../src/control-plane/jwt.ts';
import { PgTenantRegistry } from '../../src/control-plane/tenants.ts';
import { signingKey, TokenService } from '../../src/control-plane/tokens.ts';
import { PgUserDirectory } from '../../src/control-plane/users.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';
import { hostKey } from './support.ts';

const why = await postgresUnavailable();
const SERVICE = 'https://docs.example.test';

describe.skipIf(why)('durable revocation in PostgreSQL (PRO-016; BE-031)', () => {
  let db: TestDatabase | null = null;
  const host = hostKey('ES256');
  const docA = uuid7();
  const docB = uuid7();
  let tenant: string;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  /** A token service over the given directory; a second one over the same database is a restart. */
  const services = (nowFn: () => number) => {
    const registry = new PgTenantRegistry(db!.service);
    const users = new PgUserDirectory(db!.service);
    const tokens = new TokenService({
      registry,
      users,
      serviceId: SERVICE,
      signing: signingKey(undefined, 'svc-pro-016'),
      now: nowFn,
    });
    return { registry, users, tokens };
  };

  const sign = (iat: number, docs: Record<string, string>) =>
    signJws(
      { alg: host.alg, typ: 'JWT', kid: host.kid },
      {
        iss: 'host',
        aud: SERVICE,
        iat,
        exp: iat + 300,
        jti: uuid7(),
        tid: tenant,
        sub: 'pro-016-user',
        docs,
      },
      host.privateKey,
    );

  it('keeps a whole-tenant watermark across a restart and refuses the older token on both calls', async () => {
    tenant = randomUUID();
    let clock = Date.now();
    const first = services(() => clock);
    await first.registry.putTenant(tenant, 'PRO-016 tenant');
    await first.registry.addKey(tenant, {
      kid: host.kid,
      use: 'user',
      alg: 'ES256',
      jwk: host.jwk,
    });

    const before = sign(Math.floor(clock / 1000), { [docA]: 'editor', [docB]: 'viewer' });
    clock += 5_000;
    const at = Math.floor(clock / 1000) * 1000;
    await first.users.revoke(tenant, 'pro-016-user', null, at);

    // The same process refuses the token issued before the watermark.
    await expect(first.tokens.verifyUser(before)).rejects.toMatchObject({ code: 'revoked' });

    // A restarted service (a new directory and token service over the same PostgreSQL database).
    const restarted = services(() => clock);
    await expect(restarted.tokens.verifyUser(before)).rejects.toMatchObject({ code: 'revoked' });
    // A token issued in the same second as the watermark still works (D73).
    await expect(
      restarted.tokens.verifyUser(sign(Math.floor(clock / 1000), { [docA]: 'editor' })),
    ).resolves.toBeTruthy();

    // The watermark is in the table, not in process memory.
    const row = await db!.admin.query<{ revoked_before: Date | null }>(
      'SELECT revoked_before FROM tenant_users WHERE tenant_id = $1 AND sub = $2',
      [tenant, 'pro-016-user'],
    );
    expect(row.rows[0]?.revoked_before).not.toBeNull();
  });

  it('refuses only the tokens of a document revoked for one document, after a restart', async () => {
    const t = randomUUID();
    let clock = Date.now();
    const first = services(() => clock);
    await first.registry.putTenant(t, 'PRO-016 per-document');
    await first.registry.addKey(t, { kid: host.kid, use: 'user', alg: 'ES256', jwk: host.jwk });
    tenant = t;

    const both = sign(Math.floor(clock / 1000), { [docA]: 'editor', [docB]: 'viewer' });
    const onlyA = sign(Math.floor(clock / 1000), { [docA]: 'editor' });
    clock += 5_000;
    await first.users.revoke(t, 'pro-016-user', docA, Math.floor(clock / 1000) * 1000);

    const restarted = services(() => clock);
    const identity = await restarted.tokens.verifyUser(both);
    expect(identity.doc).toBe(docB);
    await expect(restarted.tokens.verifyUser(onlyA)).rejects.toMatchObject({ code: 'revoked' });
  });
});
