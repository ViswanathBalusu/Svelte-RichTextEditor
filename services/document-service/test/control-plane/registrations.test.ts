// Tenant registrations and user surrogates against memory and PostgreSQL (BE-012, BE-013;
// PRM-002 criterion 5): a seed stores a tenant with its key sets, API keys and origins; surrogates
// are made once per tenant; the name can be purged alone; erasing deletes the mapping only; and
// verifying tokens never writes permission data.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, describe, expect, it } from 'vitest';
import { signJws } from '../../src/control-plane/jwt.ts';
import { applySeed, parseSeed } from '../../src/control-plane/seed.ts';
import {
  hashSecret,
  MemoryTenantRegistry,
  PgTenantRegistry,
  type TenantRegistry,
} from '../../src/control-plane/tenants.ts';
import { signingKey, TokenService } from '../../src/control-plane/tokens.ts';
import {
  MemoryUserDirectory,
  PgUserDirectory,
  type UserDirectory,
} from '../../src/control-plane/users.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';
import { hostKey } from './support.ts';

const why = await postgresUnavailable();
const db: TestDatabase | null = why ? null : await createTestDatabase();
afterAll(async () => {
  await db?.drop();
});

const kinds: Array<{
  name: string;
  skip: string | null;
  registry: () => TenantRegistry;
  users: () => UserDirectory;
}> = [
  {
    name: 'memory',
    skip: null,
    registry: () => new MemoryTenantRegistry(),
    users: () => new MemoryUserDirectory(),
  },
  {
    name: 'postgres',
    skip: why,
    registry: () => new PgTenantRegistry(db!.service),
    users: () => new PgUserDirectory(db!.service),
  },
];

for (const k of kinds) {
  describe(`registrations and surrogates (${k.name})`, () => {
    it.skipIf(k.skip)(
      'stores a seeded tenant with its user keys, service keys, API keys and origins (BE-012 criterion 1)',
      async () => {
        const registry = k.registry();
        const tenant = randomUUID();
        const user = hostKey('ES256');
        const service = hostKey('EdDSA');
        const apiKeyId = randomUUID();
        const seed = parseSeed({
          tenants: [
            {
              id: tenant,
              name: 'Seeded',
              keys: [
                {
                  kid: user.kid,
                  use: 'user',
                  alg: 'ES256',
                  jwk: user.jwk,
                  issuer: 'https://host.example.test',
                },
                { kid: service.kid, use: 'service', alg: 'EdDSA', jwk: service.jwk },
              ],
              apiKeys: [
                {
                  id: apiKeyId,
                  secretSha256: hashSecret('s'.repeat(40)).toString('hex'),
                  label: 'backend',
                },
              ],
              origins: ['https://App.Example.test'],
            },
          ],
        });
        await applySeed(registry, seed);
        await applySeed(registry, seed); // idempotent
        expect(await registry.exists(tenant)).toBe(true);
        expect((await registry.keys(tenant, 'user')).map((x) => [x.kid, x.alg, x.issuer])).toEqual([
          [user.kid, 'ES256', 'https://host.example.test'],
        ]);
        expect((await registry.keys(tenant, 'service')).map((x) => [x.kid, x.alg])).toEqual([
          [service.kid, 'EdDSA'],
        ]);
        expect((await registry.apiKey(tenant, apiKeyId))?.label).toBe('backend');
        expect(await registry.origins(tenant)).toEqual(['https://app.example.test']);
        expect(await registry.originRegistered('https://app.example.test')).toBe(true);
        expect(await registry.originRegistered('https://nobody.example.test')).toBe(false);
        expect(() =>
          parseSeed({
            tenants: [
              { id: tenant, name: 'x', keys: [{ kid: 'k', alg: 'HS256', use: 'user', jwk: {} }] },
            ],
          }),
        ).toThrow(/keys\/0/);
        // A key of the wrong kind for its algorithm, or a private key, is refused.
        await expect(
          registry.addKey(tenant, { kid: 'wrong', use: 'user', alg: 'RS256', jwk: user.jwk }),
        ).rejects.toThrow();
        await expect(
          registry.addKey(tenant, {
            kid: 'private',
            use: 'user',
            alg: 'ES256',
            jwk: { ...user.jwk, d: 'AAAA' },
          }),
        ).rejects.toThrow();
      },
    );

    it.skipIf(k.skip)(
      'maps a sub to a surrogate once per tenant, purges names alone and erases the mapping (BE-013 criteria 1, 2, 3, 5)',
      async () => {
        const users = k.users();
        const [t1, t2] = [randomUUID(), randomUUID()];
        const registry = k.registry();
        await registry.putTenant(t1, 'one');
        await registry.putTenant(t2, 'two');
        const a = await users.resolve(t1, 'pat', 'Pat');
        const again = await Promise.all([users.resolve(t1, 'pat'), users.resolve(t1, 'pat')]);
        expect(again.map((x) => x.surrogate)).toEqual([a.surrogate, a.surrogate]);
        const b = await users.resolve(t2, 'pat');
        expect(b.surrogate).not.toBe(a.surrogate);
        expect(await users.displayName(t1, 'pat')).toBe('Pat');
        expect(await users.purgeName(t1, 'pat')).toBe(true);
        expect(await users.displayName(t1, 'pat')).toBeNull();
        expect((await users.resolve(t1, 'pat')).surrogate).toBe(a.surrogate);
        expect(await users.subsOf(t1, [a.surrogate])).toEqual(new Map([[a.surrogate, 'pat']]));
        expect(await users.erase(t1, 'pat')).toBe(true);
        expect(await users.subsOf(t1, [a.surrogate])).toEqual(new Map());
        expect(await users.subsOf(t2, [b.surrogate])).toEqual(new Map([[b.surrogate, 'pat']]));
      },
    );

    it.skipIf(k.skip || k.name !== 'postgres')(
      'writes no permission data when tokens with other docs and grp are verified (PRM-002 criterion 5)',
      async () => {
        const registry = k.registry();
        const users = k.users();
        const tenant = randomUUID();
        const key = hostKey('EdDSA');
        await registry.putTenant(tenant, 'perm');
        await registry.addKey(tenant, { kid: key.kid, use: 'user', alg: 'EdDSA', jwk: key.jwk });
        const tokens = new TokenService({
          registry,
          users,
          serviceId: 'svc',
          signing: signingKey(),
        });
        const count = async () =>
          (
            await db!.admin.query<{ n: string }>(
              `SELECT (SELECT count(*) FROM region_grants) + (SELECT count(*) FROM grant_history)
                  + (SELECT count(*) FROM grant_revisions) + (SELECT count(*) FROM region_states)
                  + (SELECT count(*) FROM region_leases) AS n`,
            )
          ).rows[0]!.n;
        const before = await count();
        for (const [role, grp] of [
          ['viewer', ['a']],
          ['owner', ['b', 'c']],
          ['filler', []],
        ] as const) {
          const iat = Math.floor(Date.now() / 1000);
          await tokens.verifyUser(
            signJws(
              { alg: 'EdDSA', typ: 'JWT', kid: key.kid },
              {
                iss: 'h',
                aud: 'svc',
                iat,
                exp: iat + 60,
                jti: uuid7(),
                tid: tenant,
                sub: 'quinn',
                grp,
                docs: { [uuid7()]: role },
              },
              key.privateKey,
            ),
          );
        }
        expect(await count()).toBe(before);
      },
    );
  });
}
