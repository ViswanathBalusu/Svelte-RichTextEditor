// UX-077 criterion 5 (lane w3): the key and origin writes of the administration API are audited,
// over HTTP in the composed service, in memory and on PostgreSQL. The routes are POST /keys,
// DELETE /keys/{kid}, POST /origins and DELETE /origins/{origin} (docs/adr/0372-w3-UX-077-key-origin-writes.md).
// The same tests show the writes work: a token signed by a newly registered key is accepted, a
// removed key's token is refused at once, a symmetric or private key is refused and writes nothing,
// a user token is refused, and a second tenant never sees or changes the first one's entries.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostKey, skipReason, startHarness, type Harness, type Storage } from './support.ts';

interface Item {
  kind: string;
  actor: string;
  document: string | null;
  at: string;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`key and origin writes in the composed service (${storage}; UX-077)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;

    const audit = async (kind: string): Promise<Item[]> => {
      const r = await h.call('GET', `/v1/audit?kind=${kind}`, { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      return r.json.items as Item[];
    };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      h.call('POST', path, {
        token: h.apiKey,
        body,
        headers: { 'Idempotency-Key': randomUUID(), ...headers },
      });
    /** Whether a user token signed by `key` is accepted by the service. */
    const accepted = async (key: ReturnType<typeof hostKey>): Promise<boolean> => {
      const t = h.userToken({ [doc]: 'viewer' }, { sub: 'rotator' }, key);
      const r = await h.call('GET', `/v1/documents/${doc}`, { token: t });
      return r.status === 200;
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      doc = await h.createDocument({ title: 'Keys' });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'registers a key, accepts its tokens, rotates it, and audits each change',
      async () => {
        const next = hostKey('ES256', `w3-next-${randomUUID()}`);
        expect(await accepted(next)).toBe(false);
        const before = h.now();
        const made = await post('/v1/keys', {
          kid: next.kid,
          use: 'user',
          alg: next.alg,
          jwk: next.jwk,
        });
        expect(made.status, made.text).toBe(201);
        expect(made.json).toMatchObject({ kid: next.kid, use: 'user', alg: 'ES256' });
        // Both keys verify during the overlap (criterion 2 of the story).
        expect(await accepted(next)).toBe(true);
        expect(await accepted(h.host)).toBe(true);
        const listed = await h.call('GET', '/v1/keys', { token: h.apiKey });
        expect((listed.json.keys as Array<{ kid: string }>).map((k) => k.kid)).toContain(next.kid);

        const removed = await h.call('DELETE', `/v1/keys/${encodeURIComponent(next.kid)}`, {
          token: h.apiKey,
        });
        expect(removed.status, removed.text).toBe(204);
        expect(await accepted(next)).toBe(false);
        expect(await accepted(h.host)).toBe(true);
        const after = h.now();

        const reg = (await audit('key.registered')).filter((i) => i.document === null);
        const gone = await audit('key.removed');
        expect(reg).toHaveLength(1);
        expect(gone).toHaveLength(1);
        for (const i of [...reg, ...gone]) {
          expect(i.actor).toMatch(/\S/);
          expect(Date.parse(i.at)).toBeGreaterThanOrEqual(before);
          expect(Date.parse(i.at)).toBeLessThanOrEqual(after);
        }
        // The stored event names the key by identifier and thumbprint: no member of the key.
        const stored = await h.parts.audit!.query(h.tenant, { kind: 'key.registered', limit: 10 });
        expect(stored[0]!.data).toMatchObject({ kid: next.kid, use: 'user', alg: 'ES256' });
        expect(JSON.stringify(stored[0]!.data)).not.toContain(
          String((next.jwk as Record<string, unknown>)['x']),
        );
      },
    );

    it.skipIf(skip)(
      'refuses a symmetric, private or unsupported key, writes nothing and audits nothing',
      async () => {
        const n = (await audit('key.registered')).length;
        const k = hostKey('EdDSA', `w3-bad-${randomUUID()}`);
        const bad = [
          { kid: 'w3-hs', use: 'user', alg: 'HS256', jwk: { kty: 'oct', k: 'c2VjcmV0' } },
          { kid: 'w3-oct', use: 'user', alg: 'EdDSA', jwk: { kty: 'oct', k: 'c2VjcmV0' } },
          { kid: 'w3-priv', use: 'user', alg: 'EdDSA', jwk: { ...k.jwk, d: 'AAAA' } },
          { kid: 'w3-use', use: 'other', alg: 'EdDSA', jwk: k.jwk },
          { kid: '', use: 'user', alg: 'EdDSA', jwk: k.jwk },
          { kid: 'w3-notkey', use: 'user', alg: 'EdDSA', jwk: { kty: 'OKP', crv: 'Ed25519' } },
        ];
        for (const body of bad) {
          const r = await post('/v1/keys', body);
          expect(r.status, JSON.stringify(body)).toBe(400);
          expect(r.json.code).toBe('validation_failed');
        }
        const keys = (await h.call('GET', '/v1/keys', { token: h.apiKey })).json.keys as Array<{
          kid: string;
        }>;
        expect(keys.map((x) => x.kid).filter((x) => x.startsWith('w3-'))).toEqual([]);
        expect(await audit('key.registered')).toHaveLength(n);
      },
    );

    it.skipIf(skip)('refuses a key already registered under another identifier', async () => {
      const r = await post('/v1/keys', {
        kid: 'w3-dup',
        use: 'user',
        alg: h.host.alg,
        jwk: h.host.jwk,
      });
      expect(r.status, r.text).toBe(409);
      expect(r.json.code).toBe('conflict');
    });

    it.skipIf(skip)('answers not_found for a key that is not registered', async () => {
      const r = await h.call('DELETE', '/v1/keys/w3-nothing', { token: h.apiKey });
      expect(r.status).toBe(404);
      expect(await audit('key.removed')).toHaveLength(1);
    });

    it.skipIf(skip)('adds and removes an origin, and audits each change once', async () => {
      const origin = 'https://new.w3.example.test';
      const made = await post('/v1/origins', { origin: 'HTTPS://New.W3.example.test:443' });
      expect(made.status, made.text).toBe(201);
      expect(made.json).toEqual({ origin });
      // Adding it again changes nothing and is not audited a second time.
      expect((await post('/v1/origins', { origin })).status).toBe(201);
      expect(
        ((await h.call('GET', '/v1/origins', { token: h.apiKey })).json.origins as string[]).sort(),
      ).toEqual(['https://app.example.test', origin]);
      expect(await audit('origin.added')).toHaveLength(1);

      const gone = await h.call('DELETE', `/v1/origins/${encodeURIComponent(origin)}`, {
        token: h.apiKey,
      });
      expect(gone.status, gone.text).toBe(204);
      expect((await h.call('GET', '/v1/origins', { token: h.apiKey })).json.origins).toEqual([
        'https://app.example.test',
      ]);
      expect(await audit('origin.removed')).toHaveLength(1);
      const stored = await h.parts.audit!.query(h.tenant, { kind: 'origin.added', limit: 10 });
      expect(stored[0]!.data).toEqual({ origin });
    });

    it.skipIf(skip)('refuses an origin with a path and one that is not registered', async () => {
      expect((await post('/v1/origins', { origin: 'https://a.example.test/x' })).status).toBe(400);
      expect((await post('/v1/origins', { origin: 'ftp://a.example.test' })).status).toBe(400);
      expect((await post('/v1/origins', {})).status).toBe(400);
      const r = await h.call(
        'DELETE',
        `/v1/origins/${encodeURIComponent('https://x.example.test')}`,
        {
          token: h.apiKey,
        },
      );
      expect(r.status).toBe(404);
      expect(await audit('origin.added')).toHaveLength(1);
    });

    it.skipIf(skip)('refuses a user token on every write, and changes nothing', async () => {
      const user = h.userToken({});
      const k = hostKey('EdDSA', 'w3-user-try');
      const headers = { 'Idempotency-Key': randomUUID() };
      const calls = [
        h.call('POST', '/v1/keys', {
          token: user,
          body: { kid: k.kid, use: 'user', alg: k.alg, jwk: k.jwk },
          headers,
        }),
        h.call('DELETE', `/v1/keys/${encodeURIComponent(h.host.kid)}`, { token: user }),
        h.call('POST', '/v1/origins', {
          token: user,
          body: { origin: 'https://u.example.test' },
          headers: { 'Idempotency-Key': randomUUID() },
        }),
        h.call('DELETE', `/v1/origins/${encodeURIComponent('https://app.example.test')}`, {
          token: user,
        }),
      ];
      for (const r of await Promise.all(calls)) expect(r.status).toBe(403);
      expect(await accepted(h.host)).toBe(true);
    });
  });
}
