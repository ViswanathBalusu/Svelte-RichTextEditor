// SEC-048 criterion 6 on PostgreSQL (lane U-SEC-033-048): a rehearsal of the rotation procedure
// against the PostgreSQL tenant registry (PgTenantRegistry, migration 0004), in a database this test
// creates and drops. The rehearsal runs, in order: a webhook secret rotated with an overlap; a
// service credential rotated with an overlap that is closed by expiring the old key; a tenant
// verification key replaced; a compromised service credential revoked. Each step writes one line
// to a record file (rehearsals/sec-048-secret-rotation.json, next to this test), with the outcome,
// the PostgreSQL server version and the time. The record holds no secret: keys are generated here
// and only their identifiers are written.
// Skips, with the reason, when the integration environment is not up (infra/test-env.ps1 up).
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateSecret,
  signDelivery,
  verifyDelivery,
} from '../../src/control-plane/webhook-signing.ts';
import { hashSecret, PgTenantRegistry } from '../../src/control-plane/tenants.ts';
import { newApiKey, signingKey, TokenService } from '../../src/control-plane/tokens.ts';
import { MemoryUserDirectory } from '../../src/control-plane/users.ts';
import { keyPair, signJws } from '../../../../tests/security/test/support/jws.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const SERVICE = 'https://docs.example.test';
const ISSUER = 'https://host.example.test';
const RECORD = fileURLToPath(new URL('./rehearsals/sec-048-secret-rotation.json', import.meta.url));

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  at: string;
}

describe.skipIf(unavailable !== null)(
  'SEC-048 criterion 6 on PostgreSQL: the rotation procedure is rehearsed and recorded',
  () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    }, 120_000);

    afterAll(async () => {
      await db?.drop();
    }, 120_000);

    it('rehearses each rotation step on PostgreSQL and writes the record', async () => {
      const steps: Step[] = [];
      const step = async (name: string, detail: string, fn: () => Promise<void> | void) => {
        try {
          await fn();
          steps.push({ step: name, ok: true, detail, at: new Date().toISOString() });
        } catch (e) {
          steps.push({
            step: name,
            ok: false,
            detail: `${detail}: ${e instanceof Error ? e.message : String(e)}`,
            at: new Date().toISOString(),
          });
          throw e;
        }
      };

      const version = await db.admin.query<{ v: string }>(
        "SELECT current_setting('server_version') AS v",
      );
      const registry = new PgTenantRegistry(db.service);
      const tenant = randomUUID();
      await registry.putTenant(tenant, 'SEC-048 rehearsal');
      const tokens = new TokenService({
        registry,
        users: new MemoryUserDirectory(),
        serviceId: SERVICE,
        signing: signingKey(undefined, 'svc'),
        now: () => Date.now(),
      });

      // 1. A webhook secret: both secrets verify during the overlap, then only the new one.
      await step(
        'webhook secret overlap',
        'old and new secret verify during the overlap; after it only the new one',
        () => {
          const body = '{"type":"document.changed","data":{"doc":"rehearsal"}}';
          const now = Math.floor(Date.now() / 1000);
          const oldSecret = generateSecret();
          const newSecret = generateSecret();
          const during = signDelivery({
            id: 'msg_rehearsal_1',
            timestamp: now,
            body,
            secrets: [oldSecret, newSecret],
          });
          expect(verifyDelivery({ headers: during, body, secrets: [oldSecret], now })).toEqual({
            ok: true,
          });
          expect(verifyDelivery({ headers: during, body, secrets: [newSecret], now })).toEqual({
            ok: true,
          });
          const after = signDelivery({
            id: 'msg_rehearsal_2',
            timestamp: now,
            body,
            secrets: [newSecret],
          });
          expect(verifyDelivery({ headers: after, body, secrets: [newSecret], now })).toEqual({
            ok: true,
          });
          expect(verifyDelivery({ headers: after, body, secrets: [oldSecret], now })).toEqual({
            ok: false,
            reason: 'bad_signature',
          });
        },
      );

      // 2. A service credential: old and new keys work in the overlap; expiring the old key ends it.
      const oldKey = newApiKey(tenant);
      const newKey = newApiKey(tenant);
      await step(
        'service credential overlap',
        'old and new API keys work during the overlap; the old one is refused once expired',
        async () => {
          await registry.addApiKey(tenant, {
            id: oldKey.id,
            secretHash: hashSecret(oldKey.secret),
          });
          await registry.addApiKey(tenant, {
            id: newKey.id,
            secretHash: hashSecret(newKey.secret),
          });
          expect((await tokens.verifyService(oldKey.credential)).tenant).toBe(tenant);
          expect((await tokens.verifyService(newKey.credential)).tenant).toBe(tenant);
          expect(await registry.expireApiKey(tenant, oldKey.id, Date.now() - 1000)).toBe(true);
          await expect(tokens.verifyService(oldKey.credential)).rejects.toThrow(/expired/);
          expect((await tokens.verifyService(newKey.credential)).tenant).toBe(tenant);
        },
      );

      // 3. A tenant verification key replaced: tokens of the removed key are refused.
      const oldHost = keyPair('ES256');
      const newHost = keyPair('ES256');
      const doc = randomUUID();
      const mint = (kid: string, key: ReturnType<typeof keyPair>) => {
        const now = Math.floor(Date.now() / 1000);
        return signJws(
          { alg: 'ES256', typ: 'JWT', kid },
          {
            iss: ISSUER,
            aud: SERVICE,
            iat: now,
            exp: now + 300,
            jti: randomUUID(),
            tid: tenant,
            sub: 'ann',
            docs: { [doc]: 'editor' },
          },
          { key: key.privateKey },
        );
      };
      await step(
        'tenant verification key replaced',
        'a token of the removed key is refused; a token of the new key is accepted',
        async () => {
          await registry.addKey(tenant, {
            kid: 'host-old',
            use: 'user',
            alg: 'ES256',
            jwk: oldHost.jwk,
          });
          const oldToken = mint('host-old', oldHost);
          expect((await tokens.verifyUser(oldToken)).tenant).toBe(tenant);
          await registry.addKey(tenant, {
            kid: 'host-new',
            use: 'user',
            alg: 'ES256',
            jwk: newHost.jwk,
          });
          expect(await registry.removeKey(tenant, 'host-old')).toBe(true);
          await expect(tokens.verifyUser(oldToken)).rejects.toThrow(/no key registered/);
          expect((await tokens.verifyUser(mint('host-new', newHost))).tenant).toBe(tenant);
        },
      );

      // 4. A compromised service credential revoked: refused on the next call.
      const compromised = newApiKey(tenant);
      await step(
        'compromised service credential revoked',
        'a revoked API key is refused on the next call',
        async () => {
          await registry.addApiKey(tenant, {
            id: compromised.id,
            secretHash: hashSecret(compromised.secret),
          });
          expect((await tokens.verifyService(compromised.credential)).tenant).toBe(tenant);
          expect(await registry.removeApiKey(tenant, compromised.id)).toBe(true);
          await expect(tokens.verifyService(compromised.credential)).rejects.toThrow(
            /not registered/,
          );
        },
      );

      const record = {
        procedure: 'SEC-048 rotation (webhook secret, service credential, tenant key, revocation)',
        engine: `PostgreSQL ${version.rows[0]?.v ?? 'unknown'}`,
        database: db.name,
        where: 'PostgreSQL in Podman, the shared test environment (infra/test-env.ps1), 127.0.0.1',
        started: steps[0]?.at ?? null,
        steps,
        allPassed: steps.every((s) => s.ok),
      };
      mkdirSync(fileURLToPath(new URL('./rehearsals/', import.meta.url)), { recursive: true });
      writeFileSync(RECORD, JSON.stringify(record, null, 2) + '\n', 'utf8');
      expect(record.allPassed).toBe(true);
      expect(steps).toHaveLength(4);
    }, 120_000);
  },
);
