// PRM-021 criterion 3: a role a host changes reaches an open channel only at the next refresh,
// and no token lives more than 15 minutes after issue (05 §3.1; 07 §9). The service's own minted
// tokens are used here, so the lifetime bound is the one the service enforces when it mints.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryTenantRegistry } from '../../src/control-plane/tenants.ts';
import { signingKey, TokenService } from '../../src/control-plane/tokens.ts';
import { MemoryUserDirectory } from '../../src/control-plane/users.ts';
import { hostKey } from './support.ts';

const SERVICE = 'https://docs.example.test';
const SECOND = 1000;

describe('the lifetime of the role a token carries (PRM-021 criterion 3)', () => {
  let now = Date.now();
  let tenant: string;
  let tokens: TokenService;
  const doc = uuid7();

  beforeEach(async () => {
    now = Date.now();
    tenant = randomUUID();
    const registry = new MemoryTenantRegistry(() => now);
    const host = hostKey('ES256');
    await registry.putTenant(tenant, 't');
    await registry.addKey(tenant, { kid: host.kid, use: 'user', alg: 'ES256', jwk: host.jwk });
    tokens = new TokenService({
      registry,
      users: new MemoryUserDirectory(),
      serviceId: SERVICE,
      signing: signingKey(undefined, 'svc'),
      now: () => now,
    });
  });

  it('keeps the old role in force until the token expires, and never beyond 15 minutes after issue', async () => {
    // A lifetime of an hour is asked for; the service caps it at 15 minutes.
    const minted = await tokens.mint(tenant, {
      sub: 'h-1',
      docs: { [doc]: 'editor' },
      expiresIn: 3600,
    });
    const id = await tokens.verifyUser(minted.token);
    expect(id.expiresAt - id.issuedAt).toBe(15 * 60 * SECOND);
    // Just before the 15-minute mark the role the token carries still applies.
    now = id.issuedAt + 899 * SECOND;
    expect((await tokens.verifyUser(minted.token)).docs).toEqual({ [doc]: 'editor' });
    // Past the expiry and its clock skew the token, and so the role it carries, is refused.
    now = id.issuedAt + (900 + 61) * SECOND;
    await expect(tokens.verifyUser(minted.token)).rejects.toMatchObject({ code: 'token_expired' });
  });
});
