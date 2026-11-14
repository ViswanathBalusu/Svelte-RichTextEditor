// hello verification through the real service (BE-029 criterion 2, lane U-BE-029-042): the
// process from src/server.ts with its real data plane, memory storage, and a WebSocket client.
// A token is accepted only when its key is registered for the tenant it names, its algorithm is
// allowed, `aud` is the service identifier and `exp` is at most 15 minutes after `iat`; any other
// answer is an `error` and the close code 4401.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { signJws } from '../../src/control-plane/jwt.ts';
import { startService, type Service } from '../../src/server.ts';
import { DepClient } from '../data-plane/client.ts';
import { hostKey } from '../control-plane/support.ts';

describe('hello token verification through the service (BE-029 criterion 2)', () => {
  let s: Service;
  let tenant: string;
  const key = hostKey('ES256');

  beforeAll(async () => {
    s = await startService({ config: { ...configFromEnv({}), port: 0, workers: 1 } });
    tenant = randomUUID();
    await s.parts.registry.putTenant(tenant, 'hello verification');
    await s.parts.registry.addKey(tenant, {
      kid: key.kid,
      use: 'user',
      alg: key.alg,
      jwk: key.jwk,
    });
  });

  afterAll(async () => {
    await s?.close();
  });

  const wsUrl = () => `${s.url.replace('http:', 'ws:')}/dep`;

  /** A user token signed with `k`; the claims can be overridden for the refusal cases. */
  const mint = (over: Record<string, unknown> = {}, k = key) => {
    const iat = Math.floor(Date.now() / 1000);
    return signJws(
      { alg: k.alg, typ: 'JWT', kid: k.kid },
      {
        iss: 'https://host.example.test',
        aud: s.url,
        iat,
        exp: iat + 300,
        jti: uuid7(),
        tid: tenant,
        sub: 'ann',
        docs: { [uuid7()]: 'viewer' },
        ...over,
      },
      k.privateKey,
    );
  };

  it('welcomes a valid token and refuses each invalid one with an error and 4401', async () => {
    const good = await DepClient.connect(wsUrl());
    try {
      const answer = await good.hello(mint());
      expect(answer.t, JSON.stringify(answer)).toBe('welcome');
    } finally {
      good.close();
    }

    const refusals: Array<[string, string]> = [
      ['a key this tenant did not register', mint({}, hostKey('ES256'))],
      [
        'an audience other than the service identifier',
        mint({ aud: 'https://other.example.test' }),
      ],
      [
        'an expiry more than 15 minutes after issue',
        mint({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      ],
      [
        'the algorithm none',
        (() => {
          const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
          const iat = Math.floor(Date.now() / 1000);
          return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ iss: 'x', aud: s.url, iat, exp: iat + 300, tid: tenant, sub: 'ann', docs: {} })}.`;
        })(),
      ],
    ];
    for (const [what, token] of refusals) {
      const c = await DepClient.connect(wsUrl());
      try {
        const answer = await c.hello(token);
        expect(answer.t, what).toBe('error');
        expect((await c.closed).code, what).toBe(4401);
      } finally {
        c.close();
      }
    }
  });
});
