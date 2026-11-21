// BE-031 criterion 4 (lane U-BE-029-042): the revocation watermark is stored in PostgreSQL
// (`tenant_users.revoked_before`), so a token issued before a revocation is still refused after the
// service restarts, which here is a new TokenService over a new PgUserDirectory on the same
// database. Runs against the PostgreSQL of the test environment (Podman); skipped when it is down.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signJws } from '../../src/control-plane/jwt.ts';
import { PgTenantRegistry } from '../../src/control-plane/tenants-pg.ts';
import { signingKey, TokenService } from '../../src/control-plane/tokens.ts';
import { PgUserDirectory } from '../../src/control-plane/users.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';
import { hostKey } from './support.ts';

const SERVICE = 'https://docs.example.test';
const skip = await postgresUnavailable();

describe.skipIf(skip !== null)(
  'revocation survives a restart (BE-031 criterion 4, PostgreSQL)',
  () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      await db?.drop();
    });

    it('refuses a token issued before the revocation after a new directory and verifier are made', async () => {
      const host = hostKey('ES256');
      const tenant = randomUUID();
      const registry = new PgTenantRegistry(db.service);
      await registry.putTenant(tenant, 'revocation restart');
      await registry.addKey(tenant, { kid: host.kid, use: 'user', alg: 'ES256', jwk: host.jwk });
      const signing = signingKey(undefined, 'svc-restart');
      const verifier = () =>
        new TokenService({
          registry,
          users: new PgUserDirectory(db.service),
          serviceId: SERVICE,
          signing,
          now: () => Date.now(),
        });

      const iat = Math.floor(Date.now() / 1000);
      const sign = (issued: number) =>
        signJws(
          { alg: host.alg, typ: 'JWT', kid: host.kid },
          {
            iss: 'host',
            aud: SERVICE,
            iat: issued,
            exp: issued + 300,
            jti: uuid7(),
            tid: tenant,
            sub: 'u-restart',
            docs: { [uuid7()]: 'viewer' },
          },
          host.privateKey,
        );

      // Issued ten seconds before the revocation, which is recorded at the current second.
      const before = sign(iat - 10);
      await new PgUserDirectory(db.service).revoke(tenant, 'u-restart', null, iat * 1000);

      // The first verifier is discarded and a second one is made: nothing is held in memory.
      const first = verifier();
      await expect(first.verifyUser(before)).rejects.toMatchObject({ code: 'revoked' });
      await expect(verifier().verifyUser(before)).rejects.toMatchObject({ code: 'revoked' });
      // A token issued in the same second as the revocation is still accepted (D73).
      await expect(verifier().verifyUser(sign(iat))).resolves.toBeTruthy();
    });
  },
);
