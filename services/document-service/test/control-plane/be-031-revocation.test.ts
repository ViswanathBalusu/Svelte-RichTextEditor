// Revoked sessions at the token verifier (BE-031; 05 §3.3; D73; lane BE-027-039, round 2). The
// verifier is the one the REST pipeline and the data plane use (`verify: tokens.verifyUser` in
// src/server.ts), so a token refused here is refused by hello, ch.open, auth.refresh and REST alike.
// The watermark is held by MemoryUserDirectory: it is not durable across a restart, so the
// restart criterion is not tested here (the PostgreSQL directory stores it in tenant_users).
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJws } from '../../src/control-plane/jwt.ts';
import { MemoryTenantRegistry } from '../../src/control-plane/tenants.ts';
import { signingKey, TokenService } from '../../src/control-plane/tokens.ts';
import { MemoryUserDirectory } from '../../src/control-plane/users.ts';
import { hostKey } from './support.ts';

const SERVICE = 'https://docs.example.test';

describe('revoked sessions at the token verifier (BE-031)', () => {
  let now = Date.now();
  let tenant: string;
  let users: MemoryUserDirectory;
  let tokens: TokenService;
  const host = hostKey('ES256');
  const docA = uuid7();
  const docB = uuid7();

  beforeEach(async () => {
    now = Date.now();
    tenant = randomUUID();
    const registry = new MemoryTenantRegistry(() => now);
    users = new MemoryUserDirectory();
    await registry.putTenant(tenant, 't');
    await registry.addKey(tenant, { kid: host.kid, use: 'user', alg: 'ES256', jwk: host.jwk });
    tokens = new TokenService({
      registry,
      users,
      serviceId: SERVICE,
      signing: signingKey(undefined, 'svc'),
      now: () => now,
    });
  });

  /** A user token for `sub` over the given documents, issued at the current second. */
  const sign = (docs: Record<string, string> = { [docA]: 'editor' }) => {
    const iat = Math.floor(now / 1000);
    return signJws(
      { alg: host.alg, typ: 'JWT', kid: host.kid },
      {
        iss: 'host',
        aud: SERVICE,
        iat,
        exp: iat + 300,
        jti: uuid7(),
        tid: tenant,
        sub: 'u-1',
        docs,
      },
      host.privateKey,
    );
  };

  it('refuses a token issued before the watermark with revoked, and accepts one issued at or after it', async () => {
    const before = sign();
    // The revocation is recorded five seconds later, to the second, as the handler does it.
    now += 5_000;
    const at = Math.floor(now / 1000) * 1000;
    await users.revoke(tenant, 'u-1', null, at);

    await expect(tokens.verifyUser(before)).rejects.toMatchObject({ code: 'revoked' });
    // A token issued in the same second as the revocation still works (D73).
    await expect(tokens.verifyUser(sign())).resolves.toBeTruthy();
  });

  it('refuses only the tokens of a revoked document when the revocation names one document', async () => {
    const both = sign({ [docA]: 'editor', [docB]: 'viewer' });
    const onlyA = sign({ [docA]: 'editor' });
    now += 5_000;
    await users.revoke(tenant, 'u-1', docA, Math.floor(now / 1000) * 1000);

    // The token that also covers document B still names B, and is accepted.
    const identity = await tokens.verifyUser(both);
    expect(identity.doc).toBe(docB);
    // A token for document A alone has nothing left to read.
    await expect(tokens.verifyUser(onlyA)).rejects.toMatchObject({ code: 'revoked' });
  });
});
