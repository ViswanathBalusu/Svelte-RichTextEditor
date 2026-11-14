/**
 * SEC-013 — every kind of forged or misdirected token is refused, so a token for one tenant,
 * audience or document is worthless anywhere else (10 §3.2; 05 §3.1, §3.2). The adversarial client
 * forges tokens with arbitrary keys, algorithms and header members through jws.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { keyPair, publicPem } from './support/jws.ts';
import { WireClient } from './support/wire.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-013 token verification resists confusion (${storage})`, () => {
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a);
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** A GET with a forged user token; returns the problem's status and code. */
    const read = async (token: string) => {
      const r = await h.call('GET', `/v1/documents/${doc}`, { token });
      return { status: r.status, code: r.json?.code as string | undefined };
    };

    t()(
      "refuses a token signed with another tenant's key but claiming this tenant's tid",
      async () => {
        // Signed with tenant B's host key, tid claims tenant A: A's registered keys do not verify it.
        const forged = h.userToken(h.a, 'ann', { [doc]: 'editor' }, { sign: h.b.hostKey });
        expect(await read(forged)).toMatchObject({ status: 401, code: 'unauthenticated' });
      },
    );

    t()(
      'refuses alg:none, a symmetric algorithm keyed with a public key, and an algorithm off the allow-list',
      async () => {
        const none = h.userToken(h.a, 'ann', { [doc]: 'editor' }, { header: { alg: 'none' } });
        expect(await read(none)).toMatchObject({ status: 401, code: 'unauthenticated' });

        // HS256 keyed with the tenant's own public key: the classic algorithm-confusion attack.
        const hs = h.userToken(
          h.a,
          'ann',
          { [doc]: 'editor' },
          { header: { alg: 'HS256' }, hmacKey: publicPem(h.a.hostKey.publicKey) },
        );
        expect(await read(hs)).toMatchObject({ status: 401, code: 'unauthenticated' });

        const ps = h.userToken(h.a, 'ann', { [doc]: 'editor' }, { header: { alg: 'PS256' } });
        expect(await read(ps)).toMatchObject({ status: 401, code: 'unauthenticated' });
      },
    );

    t()(
      'ignores jku, x5u, jwk and a kid that names a URL, using only the registered keys',
      async () => {
        const stranger = keyPair('EdDSA'); // not registered for any tenant
        const forged = h.userToken(
          h.a,
          'ann',
          { [doc]: 'editor' },
          {
            header: {
              kid: 'https://evil.example/keys/1',
              jku: 'https://evil.example/jwks.json',
              x5u: 'https://evil.example/cert.pem',
              jwk: stranger.jwk,
            },
            claims: { jwks_uri: 'https://evil.example/jwks.json' },
            sign: stranger,
          },
        );
        expect(await read(forged)).toMatchObject({ status: 401, code: 'unauthenticated' });
      },
    );

    t()('refuses an aud that differs by case, prefix or suffix', async () => {
      for (const aud of [h.serviceId.toUpperCase(), `x${h.serviceId}`, `${h.serviceId}/`]) {
        expect(
          await read(h.userToken(h.a, 'ann', { [doc]: 'editor' }, { claims: { aud } })),
        ).toMatchObject({
          status: 401,
          code: 'unauthenticated',
        });
      }
    });

    t()(
      'refuses a token whose exp is more than 15 minutes after iat, and one expired beyond the skew',
      async () => {
        const now = Math.floor(h.now() / 1000);
        const tooLong = h.userToken(
          h.a,
          'ann',
          { [doc]: 'editor' },
          { claims: { iat: now, exp: now + 16 * 60 } },
        );
        expect(await read(tooLong)).toMatchObject({ status: 401, code: 'unauthenticated' });

        const expired = h.userToken(
          h.a,
          'ann',
          { [doc]: 'editor' },
          { claims: { iat: now - 1000, exp: now - 120 } },
        );
        expect(await read(expired)).toMatchObject({ status: 401, code: 'token_expired' });
      },
    );

    t()(
      'refuses a user token used as a service credential, and a dep-svc+jwt signed with a user-token key',
      async () => {
        // A valid user token presented on a service-only route (POST /tokens).
        const user = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const asService = await h.call('POST', '/v1/tokens', {
          token: user,
          body: { sub: 'x', docs: { [doc]: 'viewer' } },
        });
        expect(asService.status).toBe(403);
        expect(asService.json?.code).toBe('forbidden');

        // A dep-svc+jwt signed with the tenant's user-token key: no service key verifies it.
        const svcJwt = h.serviceJwt(h.a, {}, h.a.hostKey);
        const refused = await h.call('POST', '/v1/tokens', {
          token: svcJwt,
          body: { sub: 'x', docs: { [doc]: 'viewer' } },
        });
        expect(refused.status).toBe(401);
        expect(refused.json?.code).toBe('unauthenticated');
      },
    );

    t()('refuses a docs claim that lists more than 20 documents', async () => {
      const docs: Record<string, string> = {};
      for (let i = 0; i < 21; i++) docs[randomUUID()] = 'viewer';
      expect(await read(h.userToken(h.a, 'ann', docs))).toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    });

    t()(
      'a role for document A never applies to document B, and opening an uncovered document is forbidden',
      async () => {
        const other = await h.createDocument(h.a);
        // A valid token covering `other` as owner must not read `doc` at all.
        const token = h.userToken(h.a, 'ann', { [other]: 'owner' });
        expect(await read(token)).toMatchObject({ status: 403, code: 'forbidden' });

        // On the wire, opening a channel on an uncovered document is answered `forbidden`.
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await c.hello(token)).t).toBe('welcome');
          const opened = await c.open(1, doc);
          expect(opened.t).toBe('ch.rejected');
          expect(opened.d?.['code']).toBe('forbidden');
        } finally {
          c.close();
        }
      },
    );
  });
}
