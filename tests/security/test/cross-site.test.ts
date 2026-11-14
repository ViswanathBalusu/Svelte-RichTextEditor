/**
 * SEC-012 — a foreign web page cannot use a user's session (10 §3.2). The adversarial client opens
 * WebSockets from chosen origins and makes REST calls with cookies and cross-site form posts, and
 * the service refuses every one.
 *
 * Spec: 10 §3.2; 05 §3.1, §4, §6.1. Open question (SEC-012 Notes): a client that sends no `Origin`
 * header is not a browser and is accepted (ADR 0035); the final case documents that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-012 cross-site requests are refused (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()(
      'refuses a WebSocket from an origin not on the tenant allow-list, accepts an allowed one (4403)',
      async () => {
        const doc = await h.createDocument(h.a);
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });

        const bad = await WireClient.connect(h.wsUrl, { origin: 'https://evil.example' });
        try {
          const answer = await bad.hello(token);
          expect(answer.t).toBe('error');
          expect(answer.d?.['code']).toBe('forbidden');
          expect((await bad.closed).code).toBe(4403);
        } finally {
          bad.terminate();
        }

        const good = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await good.hello(token)).t).toBe('welcome');
        } finally {
          good.close();
        }
      },
    );

    t()("refuses an origin allowed for tenant A when the token is tenant B's", async () => {
      const doc = await h.createDocument(h.b);
      const tokenB = await h.mintToken(h.b, 'ben', { [doc]: 'editor' });
      // The origin is registered for A; the token's tenant is B, whose origins do not include it.
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        expect((await c.hello(tokenB)).d?.['code']).toBe('forbidden');
        expect((await c.closed).code).toBe(4403);
      } finally {
        c.terminate();
      }
    });

    t()('accepts a connection that sends no Origin header (ADR 0035; open question)', async () => {
      const doc = await h.createDocument(h.a);
      const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl); // no origin option: no header
      try {
        expect((await c.hello(token)).t).toBe('welcome');
      } finally {
        c.close();
      }
    });

    t()(
      'answers a REST request that carries only a session cookie with unauthenticated',
      async () => {
        const doc = await h.createDocument(h.a);
        const r = await h.call('GET', `/v1/documents/${doc}`, {
          headers: { Cookie: 'session=forged-ambient-credential' },
        });
        expect(r.status).toBe(401);
        expect(r.json?.code).toBe('unauthenticated');
      },
    );

    t()('lets a cross-site form post with ambient credentials change nothing', async () => {
      const doc = await h.createDocument(h.a);
      for (const contentType of [
        'application/x-www-form-urlencoded',
        'text/plain',
        'multipart/form-data; boundary=x',
      ]) {
        const r = await h.call('PATCH', `/v1/documents/${doc}`, {
          headers: { 'Content-Type': contentType, Cookie: 'session=forged' },
          raw: 'state=locked',
        });
        expect(r.status, contentType).toBe(401);
      }
      // The document is untouched: still active, read with the service credential.
      const after = await h.call('GET', `/v1/documents/${doc}`, { token: h.a.apiKey });
      expect(after.json.state).toBe('active');
    });

    t()(
      'returns no CORS grant to a disallowed origin and only the exact origin to an allowed one',
      async () => {
        const disallowed = await h.call('OPTIONS', '/v1/documents', {
          headers: {
            Origin: 'https://evil.example',
            'Access-Control-Request-Method': 'POST',
          },
        });
        expect(disallowed.status).toBe(403);
        expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();

        const allowed = await h.call('OPTIONS', '/v1/documents', {
          headers: { Origin: h.a.origin, 'Access-Control-Request-Method': 'POST' },
        });
        expect(allowed.status).toBe(204);
        expect(allowed.headers.get('access-control-allow-origin')).toBe(h.a.origin);
      },
    );
  });
}
