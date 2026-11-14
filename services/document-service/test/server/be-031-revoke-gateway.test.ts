// BE-031 criteria 2 and 3 through the real service (lane V-BE-029-042): the process from src/server.ts
// with its data plane, memory storage, and WebSocket clients. A revocation made through
// `POST /v1/sessions/revoke` closes the user's open session at once (criterion 2), and a token
// issued before the revocation is refused at `hello`, `ch.open` and `auth.refresh` (criterion 3).
// Revocation times are whole seconds (D73), so the old token is issued five seconds before the
// revocation and the new token after it.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { signJws } from '../../src/control-plane/jwt.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { startService, type Service } from '../../src/server.ts';
import { DepClient } from '../data-plane/client.ts';
import { documentWithRegions, hostKey } from '../control-plane/support.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

describe('a revocation closes the session and refuses old tokens through the service (BE-031 criteria 2, 3)', () => {
  let s: Service;
  let tenant: string;
  let apiKey: string;
  const key = hostKey('ES256');

  beforeAll(async () => {
    s = await startService({ config: { ...configFromEnv({}), port: 0, workers: 1 } });
    tenant = randomUUID();
    await s.parts.registry.putTenant(tenant, 'revocation through the gateway');
    await s.parts.registry.addKey(tenant, {
      kid: key.kid,
      use: 'user',
      alg: key.alg,
      jwk: key.jwk,
    });
    const k = newApiKey(tenant);
    await s.parts.registry.addApiKey(tenant, { id: k.id, secretHash: hashSecret(k.secret) });
    apiKey = k.credential;
  });

  afterAll(async () => {
    await s?.close();
  });

  const wsUrl = () => `${s.url.replace('http:', 'ws:')}/dep`;

  const rest = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${s.url}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
  };

  /** A user token for `sub` on `doc`, issued `ageSeconds` before now. */
  const mint = (sub: string, doc: string, ageSeconds = 0) => {
    const iat = Math.floor(Date.now() / 1000) - ageSeconds;
    return signJws(
      { alg: key.alg, typ: 'JWT', kid: key.kid },
      {
        iss: 'https://host.example.test',
        aud: s.url,
        iat,
        exp: iat + 300,
        jti: uuid7(),
        tid: tenant,
        sub,
        docs: { [doc]: 'editor' },
      },
      key.privateKey,
    );
  };

  it('closes the open session of a revoked user at once, and refuses the old token at hello, ch.open and auth.refresh', async () => {
    const created = await rest('POST', '/documents', { content: documentWithRegions() });
    expect(created.status).toBe(201);
    const doc = created.json['id'] as string;

    // The session of the user to be revoked, opened with a token issued five seconds ago.
    const old = mint('ann', doc, 5);
    const session = await DepClient.connect(wsUrl());
    try {
      expect((await session.hello(old)).t).toBe('welcome');
      expect((await session.open(1, doc)).t).toBe('ch.opened');

      // Criterion 2: the revocation of the user's sessions closes the session and its channel.
      const revoked = await rest('POST', '/sessions/revoke', { sub: 'ann' });
      expect(revoked.status).toBe(204);
      await session.take((m) => m.t === 'auth.revoked', 3000, 'auth.revoked after the revocation');
      const closed = await session.closed;
      expect(closed.code).toBe(4401);
      expect(closed.reason).toBe('revoked');
    } finally {
      session.close();
    }

    // Criterion 3, hello: the old token is refused and the connection closes with 4401.
    const refused = await DepClient.connect(wsUrl());
    try {
      const answer = await refused.hello(old);
      expect(answer.t).toBe('error');
      expect((await refused.closed).code).toBe(4401);
    } finally {
      refused.close();
    }

    // Criterion 3, REST bearer: the old token is refused on a document it covers.
    const restOld = await fetch(`${s.url}/v1/documents/${doc}`, {
      headers: { Authorization: `Bearer ${old}` },
    });
    expect(restOld.status).toBe(401);
    expect(((await restOld.json()) as Json)['code']).toBe('revoked');

    // A token issued after the revocation (in the same second or later) is accepted.
    const fresh = mint('ann', doc, 0);
    const c = await DepClient.connect(wsUrl());
    try {
      expect((await c.hello(fresh)).t).toBe('welcome');

      // Criterion 3, ch.open: the channel is refused when its own token is the old one.
      c.send({
        t: 'ch.open',
        id: 'open-old',
        ch: 1,
        d: {
          kind: 'doc',
          doc,
          engine: 'pm-steps/1',
          cdm: 1,
          features: ['fields', 'presence', 'regions'],
          token: old,
        },
      });
      const rejected = await c.take((m) => m.re === 'open-old', 3000, 'an answer to ch.open');
      expect(rejected.t).toBe('ch.rejected');
      expect(rejected.d?.['code']).toBe('forbidden');

      // Criterion 3, auth.refresh: the old token is refused.
      c.send({ t: 'auth.refresh', id: 'refresh-old', d: { token: old } });
      const refresh = await c.take(
        (m) => m.re === 'refresh-old',
        3000,
        'an answer to auth.refresh',
      );
      expect(refresh.t).toBe('error');
      expect(refresh.d?.['code']).toBe('revoked');
    } finally {
      c.close();
    }
  });
});
