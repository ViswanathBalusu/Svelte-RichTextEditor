// Discovery, the request pipeline, tokens, service credentials and documents, over real HTTP
// against an in-process service, with in-memory storage and with PostgreSQL (BE-032, BE-033,
// BE-035; PRO-008 to PRO-012, PRO-040 to PRO-042, PRO-046).
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { DEP1 } from '@docedit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJws, importPublicJwk, verifySignature } from '../../src/control-plane/jwt.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import {
  documentWithRegions,
  hostKey,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const REGISTRY_REST_CODES = new Set(
  DEP1.errors.filter((e) => e.surfaces.includes('rest')).map((e) => e.code),
);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`documents and credentials over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const codes = new Set<string>();
    const problem = (
      r: { status: number; json: { code?: string; requestId?: string } },
      status: number,
      code: string,
    ) => {
      expect(r.status).toBe(status);
      expect(r.json?.code).toBe(code);
      codes.add(code);
    };

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
      // PRO-038 criterion 2, PRO-040 criterion 1: every problem carried a code of the registry.
      for (const c of codes) expect(REGISTRY_REST_CODES.has(c), c).toBe(true);
    });

    it.skipIf(skip)(
      'publishes discovery without a token; rest is the base of every path (PRO-008)',
      async () => {
        const r = await h.call('GET', '/.well-known/dep');
        expect(r.status).toBe(200);
        expect(Object.keys(r.json).sort()).toEqual(
          ['cdm', 'engines', 'features', 'jwks_uri', 'mode', 'rest', 'versions', 'ws'].sort(),
        );
        expect(r.json.versions).toEqual(['1.0']);
        expect(r.json.engines).toContain('pm-steps/1');
        expect(r.json.cdm).toEqual({ min: 1, max: 1 });
        expect(r.json.mode).toBe('authority');
        expect(r.json.features).toEqual(expect.arrayContaining(['regions']));
        // No compile worker serves this harness's queue: `exports` is not announced (ADR 0054).
        expect(r.json.features).not.toContain('exports');
        expect(r.json.ws).toBe(`${h.base.replace('http:', 'ws:')}/dep`);
        // `rest` is the complete base URL: a resource path appended to it works.
        const list = await fetch(`${r.json.rest}/documents`, {
          headers: { Authorization: `Bearer ${h.apiKey}` },
        });
        expect(list.status).toBe(200);
        const jwks = (await (await fetch(r.json.jwks_uri)).json()) as {
          keys: Array<Record<string, string>>;
        };
        expect(jwks.keys[0]).toMatchObject({ kid: 'service-test', alg: 'EdDSA', use: 'sig' });
      },
    );

    it.skipIf(skip)(
      'answers CORS for allowed origins only (PRO-041; BE-032 criterion 3; D66)',
      async () => {
        const pre = await h.call('OPTIONS', '/v1/documents/x', {
          headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'PATCH' },
        });
        expect(pre.status).toBe(204);
        expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
        expect(pre.headers.get('access-control-allow-headers')).toBe(
          'Authorization, Content-Type, If-Match, Idempotency-Key, DEP-Actor, traceparent',
        );
        const bad = await h.call('OPTIONS', '/v1/documents/x', {
          headers: { Origin: 'https://evil.example.test', 'Access-Control-Request-Method': 'GET' },
        });
        expect(bad.status).toBe(403);
        expect(bad.headers.get('access-control-allow-origin')).toBeNull();
        expect(bad.headers.get('access-control-allow-headers')).toBeNull();
        const doc = await h.createDocument();
        const read = await h.call('GET', `/v1/documents/${doc}`, {
          token: h.userToken({ [doc]: 'viewer' }),
          headers: { Origin: 'https://app.example.test' },
        });
        expect(read.status).toBe(200);
        expect(read.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
        expect(read.headers.get('access-control-expose-headers')).toBe(
          'ETag, Retry-After, Deprecation, Sunset, DEP-Request-Id, DEP-Idempotent-Replayed',
        );
        // An origin of another tenant may not read this tenant's responses.
        const other = randomUUID();
        await h.parts.registry.putTenant(other, 'Other');
        await h.parts.registry.addOrigin(other, 'https://other.example.test');
        const foreign = await h.call('GET', `/v1/documents/${doc}`, {
          token: h.userToken({ [doc]: 'viewer' }),
          headers: { Origin: 'https://other.example.test' },
        });
        expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
      },
    );

    it.skipIf(skip)(
      'authenticates by bearer token only; problems carry the request identifier (BE-032)',
      async () => {
        const none = await h.call('GET', '/v1/documents');
        problem(none, 401, 'unauthenticated');
        expect(none.headers.get('content-type')).toBe('application/problem+json');
        expect(none.json.requestId).toBe(none.headers.get('dep-request-id'));
        expect(none.json).toMatchObject({ type: 'about:blank', status: 401 });
        // A cookie never authenticates (PRO-041 criterion 4).
        problem(
          await h.call('GET', '/v1/documents', { headers: { Cookie: `token=${h.apiKey}` } }),
          401,
          'unauthenticated',
        );
        problem(await h.call('GET', '/v1/nothing-here', { token: h.apiKey }), 404, 'not_found');
        const doc = await h.createDocument();
        problem(
          await h.call('GET', `/v1/documents/${doc}`, {
            token: `${h.userToken({ [doc]: 'viewer' })}x`,
          }),
          401,
          'unauthenticated',
        );
      },
    );

    it.skipIf(skip)(
      'refuses a body that does not match the published schema, and changes nothing (PRO-040 criterion 4)',
      async () => {
        const ext = `bad-${randomUUID()}`;
        const r = await h.call('POST', '/v1/documents', {
          token: h.apiKey,
          body: { externalId: ext, properties: 'not an object' },
        });
        problem(r, 400, 'validation_failed');
        expect(r.json.violations).toEqual([{ path: '/properties', rule: 'expected an object' }]);
        problem(
          await h.call('POST', '/v1/documents', {
            token: h.apiKey,
            raw: '{"externalId":',
            headers: { 'Content-Type': 'application/json' },
          }),
          400,
          'validation_failed',
        );
        const list = await h.call('GET', `/v1/documents?externalId=${ext}`, { token: h.apiKey });
        expect(list.json.items).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'mints user tokens for service credentials only (PRO-011; BE-033 criterion 5; D60)',
      async () => {
        const a = await h.createDocument();
        const b = await h.createDocument();
        const r = await h.call('POST', '/v1/tokens', {
          token: h.apiKey,
          body: {
            sub: 'carol',
            docs: { [a]: 'editor' },
            name: 'Carol',
            grp: ['legal'],
            restrict: ['no-print'],
          },
        });
        expect(r.status).toBe(200);
        expect(r.headers.get('cache-control')).toBe('no-store');
        const { header, payload, signingInput, signature } = decodeJws(r.json.token);
        expect(payload['exp']).toBeTypeOf('number');
        expect((payload['exp'] as number) - (payload['iat'] as number)).toBeLessThanOrEqual(900);
        expect(payload).toMatchObject({
          aud: h.serviceId,
          iss: h.serviceId,
          tid: h.tenant,
          sub: 'carol',
          docs: { [a]: 'editor' },
        });
        expect(new Date(r.json.expiresAt).getTime()).toBe((payload['exp'] as number) * 1000);
        // It verifies against the keys published at jwks_uri.
        const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as {
          keys: Array<Record<string, string>>;
        };
        const key = jwks.keys.find((k) => k['kid'] === header['kid'])!;
        expect(
          verifySignature(
            'EdDSA',
            importPublicJwk({ kty: key['kty'], crv: key['crv'], x: key['x'] }, 'EdDSA'),
            signingInput,
            signature,
          ),
        ).toBe(true);
        // A opens with editor; B is refused (PRO-011 criterion 4).
        expect((await h.call('GET', `/v1/documents/${a}`, { token: r.json.token })).status).toBe(
          200,
        );
        problem(
          await h.call('GET', `/v1/documents/${b}`, { token: r.json.token }),
          403,
          'forbidden',
        );
        // Host-signed tokens keep working beside minted ones (criterion 3).
        expect(
          (await h.call('GET', `/v1/documents/${a}`, { token: h.userToken({ [a]: 'viewer' }) }))
            .status,
        ).toBe(200);
        // A user token, or none, cannot mint (criterion 2).
        problem(
          await h.call('POST', '/v1/tokens', {
            token: h.userToken({ [a]: 'owner' }),
            body: { sub: 'x', docs: { [a]: 'owner' } },
          }),
          403,
          'forbidden',
        );
        problem(
          await h.call('POST', '/v1/tokens', { body: { sub: 'x', docs: { [a]: 'owner' } } }),
          401,
          'unauthenticated',
        );
        // A short lifetime for the kit's test mode (05 §11), never more than 15 minutes.
        const short = await h.call('POST', '/v1/tokens', {
          token: h.apiKey,
          body: { sub: 'x', docs: { [a]: 'viewer' }, expiresIn: 60 },
        });
        const p = decodeJws(short.json.token).payload;
        expect((p['exp'] as number) - (p['iat'] as number)).toBe(60);
        problem(
          await h.call('POST', '/v1/tokens', {
            token: h.apiKey,
            body: { sub: 'x', docs: { [a]: 'viewer' }, expiresIn: 901 },
          }),
          400,
          'validation_failed',
        );
        // 21 documents is more than 05 §3.1 allows.
        const docs = Object.fromEntries(Array.from({ length: 21 }, () => [uuid7(), 'viewer']));
        problem(
          await h.call('POST', '/v1/tokens', { token: h.apiKey, body: { sub: 'x', docs } }),
          400,
          'validation_failed',
        );
      },
    );

    it.skipIf(skip)(
      'accepts API keys and dep-svc+jwt on service routes and refuses user tokens there (BE-033; PRO-012)',
      async () => {
        const doc = await h.createDocument();
        expect((await h.call('GET', '/v1/documents', { token: h.serviceJwt() })).status).toBe(200);
        const user = h.userToken({ [doc]: 'owner' }, { svc: true, typ_claim: 'service' });
        for (const [method, path] of [
          ['POST', '/v1/tokens'],
          ['GET', '/v1/documents'],
          ['POST', '/v1/documents'],
          ['PUT', `/v1/documents/${doc}/content`],
          ['POST', '/v1/sessions/revoke'],
          ['POST', `/v1/documents/${doc}/fork`],
          ['GET', '/v1/webhooks'],
          ['GET', '/v1/audit'],
          ['GET', '/v1/search'],
          ['POST', `/v1/documents/${doc}/imports`],
        ] as const)
          problem(
            await h.call(method, path, { token: user, ...(method === 'GET' ? {} : { body: {} }) }),
            403,
            'forbidden',
          );
        // A token of type dep-svc+jwt signed with a user-token key is no service credential (PRO-010 criterion 5).
        problem(
          await h.call('GET', '/v1/documents', { token: h.serviceJwt({}, h.host) }),
          401,
          'unauthenticated',
        );
        // A route this server does not offer is not_found for a service credential, after the credential check.
        problem(await h.call('GET', '/v1/search', { token: h.apiKey }), 404, 'not_found');
      },
    );

    it.skipIf(skip)(
      "keeps tenants apart: a credential of one tenant never reaches another tenant's document (BE-011 criterion 2; PRO-012 criterion 3)",
      async () => {
        const doc = await h.createDocument();
        const other = randomUUID();
        await h.parts.registry.putTenant(other, 'Other');
        const k = newApiKey(other);
        await h.parts.registry.addApiKey(other, { id: k.id, secretHash: hashSecret(k.secret) });
        problem(
          await h.call('GET', `/v1/documents/${doc}`, { token: k.credential }),
          404,
          'not_found',
        );
        problem(
          await h.call('GET', `/v1/documents/${doc}/content`, { token: k.credential }),
          404,
          'not_found',
        );
        expect((await h.call('GET', '/v1/documents', { token: k.credential })).json.items).toEqual(
          [],
        );
        // A tenant in the path or the body is never read: there is none; the tenant is the credential's.
        const mine = await h.call('GET', '/v1/documents', {
          token: h.apiKey,
          headers: { 'X-Tenant': other },
        });
        expect(mine.json.items.map((d: { id: string }) => d.id)).toContain(doc);
        // A forged API key with another tenant's identifier fails on the secret.
        problem(
          await h.call('GET', '/v1/documents', { token: `dsk_${other}_${k.id}_${'x'.repeat(43)}` }),
          401,
          'unauthenticated',
        );
      },
    );

    it.skipIf(skip)(
      'applies registration changes at the next request, and overlapping API keys both work until one expires (BE-012; PRO-012 criterion 4)',
      async () => {
        const second = newApiKey(h.tenant);
        await h.parts.registry.addApiKey(h.tenant, {
          id: second.id,
          secretHash: hashSecret(second.secret),
        });
        expect((await h.call('GET', '/v1/documents', { token: h.apiKey })).status).toBe(200);
        expect((await h.call('GET', '/v1/documents', { token: second.credential })).status).toBe(
          200,
        );
        await h.parts.registry.expireApiKey(h.tenant, second.id, h.now() - 1);
        problem(
          await h.call('GET', '/v1/documents', { token: second.credential }),
          401,
          'unauthenticated',
        );
        // A new host key works for the next token, and stops when it is removed.
        const k = hostKey('RS256');
        const doc = await h.createDocument();
        problem(
          await h.call('GET', `/v1/documents/${doc}`, {
            token: h.userToken({ [doc]: 'viewer' }, {}, k),
          }),
          401,
          'unauthenticated',
        );
        await h.parts.registry.addKey(h.tenant, {
          kid: k.kid,
          use: 'user',
          alg: 'RS256',
          jwk: k.jwk,
        });
        expect(
          (
            await h.call('GET', `/v1/documents/${doc}`, {
              token: h.userToken({ [doc]: 'viewer' }, {}, k),
            })
          ).status,
        ).toBe(200);
        await h.parts.registry.removeKey(h.tenant, k.kid);
        problem(
          await h.call('GET', `/v1/documents/${doc}`, {
            token: h.userToken({ [doc]: 'viewer' }, {}, k),
          }),
          401,
          'unauthenticated',
        );
        // A user-token key offered as a service key is refused (BE-012 criterion 5).
        await expect(
          h.parts.registry.addKey(h.tenant, {
            kid: 'again',
            use: 'service',
            alg: h.host.alg,
            jwk: h.host.jwk,
          }),
        ).rejects.toThrow(/already registered/);
      },
    );

    it.skipIf(skip)(
      'creates documents with content, externalId and properties (BE-035 criterion 1; PRO-046)',
      async () => {
        const ext = `ext-${randomUUID()}`;
        const r = await h.call('POST', '/v1/documents', {
          token: h.apiKey,
          body: {
            content: documentWithRegions(),
            externalId: ext,
            properties: { project: 'p1', n: 3 },
            title: 'Contract',
            classification: 'internal',
          },
        });
        expect(r.status).toBe(201);
        expect(r.headers.get('location')).toBe(`${h.base}/v1/documents/${r.json.id}`);
        expect(r.headers.get('etag')).toBe('"m1"');
        expect(r.json).toMatchObject({
          externalId: ext,
          title: 'Contract',
          properties: { project: 'p1', n: 3 },
          classification: 'internal',
          state: 'active',
          cdm: 1,
          requires: [],
        });
        const record = await h.parts.documents.get({ tenant: h.tenant, doc: r.json.id });
        expect(record).toMatchObject({
          head: 0,
          historyVisibility: 'editors',
          cdmVersion: 1,
          requires: [],
        });
        expect(record!.incarnation).toMatch(/^[0-9a-f-]{36}$/);
        expect(h.events.of('dep.document.created.v1').map((e) => e.subject)).toContain(r.json.id);
        // Without content the document starts empty, and its content is valid CDM.
        const empty = await h.createDocument();
        const content = await h.call('GET', `/v1/documents/${empty}/content`, { token: h.apiKey });
        expect(content.json.seq).toBe(0);
        expect(content.json.doc.type).toBe('doc');
      },
    );

    it.skipIf(skip)(
      'refuses invalid CDM with the rule and the position, and creates nothing (PRO-046 criterion 2)',
      async () => {
        const ext = `bad-${randomUUID()}`;
        const content = documentWithRegions() as {
          doc: { content: Array<{ content: unknown[] }> };
        };
        content.doc.content[1]!.content.unshift({
          type: 'region',
          attrs: { id: 'short', title: 'x' },
          content: [],
        });
        const r = await h.call('POST', '/v1/documents', {
          token: h.apiKey,
          body: { content, externalId: ext },
        });
        problem(r, 400, 'validation_failed');
        expect(r.json.violations.length).toBeGreaterThan(0);
        for (const v of r.json.violations) expect(v.path).toMatch(/^\/content/);
        expect(
          (await h.call('GET', `/v1/documents?externalId=${ext}`, { token: h.apiKey })).json.items,
        ).toEqual([]);
        problem(
          await h.call('POST', '/v1/documents', { token: h.apiKey, body: { import: uuid7() } }),
          400,
          'validation_failed',
        );
        // A template that does not exist is not found (FRW-062; the templates themselves are
        // tested in frw-062.templates.test.ts).
        problem(
          await h.call('POST', '/v1/documents', { token: h.apiKey, body: { template: uuid7() } }),
          404,
          'not_found',
        );
      },
    );

    it.skipIf(skip)(
      'refuses a second document with the same externalId (BE-035 criterion 2; D62)',
      async () => {
        const ext = `dup-${randomUUID()}`;
        await h.createDocument({ externalId: ext });
        problem(
          await h.call('POST', '/v1/documents', { token: h.apiKey, body: { externalId: ext } }),
          409,
          'conflict',
        );
        expect(
          (await h.call('GET', `/v1/documents?externalId=${ext}`, { token: h.apiKey })).json.items,
        ).toHaveLength(1);
      },
    );

    it.skipIf(skip)(
      "lists the tenant's documents as cursor pages of at most 200 (BE-035 criterion 3; PRO-040)",
      async () => {
        const ext = `page-${randomUUID()}`;
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push(await h.createDocument({ externalId: `${ext}-${i}` }));
        const all = [];
        let cursor: string | null = null;
        do {
          const q: string = `/v1/documents?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const page = await h.call('GET', q, { token: h.apiKey });
          expect(page.status).toBe(200);
          expect(Object.keys(page.json).sort()).toEqual(['items', 'nextCursor']);
          expect(page.json.items.length).toBeLessThanOrEqual(2);
          all.push(...page.json.items.map((d: { id: string }) => d.id));
          cursor = page.json.nextCursor;
        } while (cursor);
        for (const id of ids) expect(all.filter((x) => x === id)).toHaveLength(1);
        const one = await h.call('GET', `/v1/documents?externalId=${ext}-1`, { token: h.apiKey });
        expect(one.json).toEqual({
          items: [expect.objectContaining({ id: ids[1], externalId: `${ext}-1` })],
          nextCursor: null,
        });
        problem(
          await h.call('GET', '/v1/documents?limit=201', { token: h.apiKey }),
          400,
          'validation_failed',
        );
        problem(
          await h.call('GET', '/v1/documents?limit=0', { token: h.apiKey }),
          400,
          'validation_failed',
        );
        problem(
          await h.call('GET', '/v1/documents?cursor=forged', { token: h.apiKey }),
          400,
          'validation_failed',
        );
        problem(
          await h.call('GET', '/v1/documents', { token: h.userToken({ [ids[0]!]: 'owner' }) }),
          403,
          'forbidden',
        );
      },
    );

    it.skipIf(skip)(
      'reads document metadata with view, and refuses a token that does not cover it (BE-035 criterion 7)',
      async () => {
        const doc = await h.createDocument({ title: 'T' });
        for (const role of ['viewer', 'commenter', 'suggester', 'filler', 'editor', 'owner']) {
          const r = await h.call('GET', `/v1/documents/${doc}`, {
            token: h.userToken({ [doc]: role }),
          });
          expect(r.status, role).toBe(200);
          expect(r.headers.get('etag')).toBe('"m1"');
        }
        problem(
          await h.call('GET', `/v1/documents/${doc}`, {
            token: h.userToken({ [randomUUID()]: 'owner' }),
          }),
          403,
          'forbidden',
        );
      },
    );

    it.skipIf(skip)(
      'updates metadata and state under If-Match; a state change raises the grants revision and tells the room (BE-035 criterion 4; PRO-042)',
      async () => {
        const doc = await h.createDocument({ properties: { a: 1 } });
        const owner = h.userToken({ [doc]: 'owner' });
        problem(
          await h.call('PATCH', `/v1/documents/${doc}`, { token: owner, body: { title: 'x' } }),
          428,
          'precondition_failed',
        );
        problem(
          await h.call('PATCH', `/v1/documents/${doc}`, {
            token: owner,
            body: { title: 'x' },
            headers: { 'If-Match': '"m9"' },
          }),
          412,
          'precondition_failed',
        );
        problem(
          await h.call('PATCH', `/v1/documents/${doc}`, {
            token: h.userToken({ [doc]: 'editor' }),
            body: { title: 'x' },
            headers: { 'If-Match': '"m1"' },
          }),
          403,
          'forbidden',
        );
        expect((await h.call('GET', `/v1/documents/${doc}`, { token: owner })).json).toMatchObject({
          title: null,
          properties: { a: 1 },
        });
        const before = (await h.parts.grants.current({ tenant: h.tenant, doc })).revision;
        const r = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: owner,
          body: { title: 'New', properties: { b: 2 }, classification: 'secret', state: 'locked' },
          headers: { 'If-Match': '"m1"' },
        });
        expect(r.status).toBe(200);
        expect(r.headers.get('etag')).toBe('"m2"');
        expect(r.json).toMatchObject({
          title: 'New',
          properties: { b: 2 },
          classification: 'secret',
          state: 'locked',
        });
        const perms = await h.parts.grants.current({ tenant: h.tenant, doc });
        expect(perms.revision).toBe(before + 1);
        expect(perms.documentState).toBe('locked');
        const notices = h.stub.notices.filter((n) => n.ref?.doc === doc);
        expect(notices.map((n) => n.kind)).toEqual(['permissions', 'document']);
        expect(notices[0]!.perms!.revision).toBe(before + 1);
        expect(
          h.events.of('dep.document.state_changed.v1').find((e) => e.subject === doc)?.data,
        ).toEqual({
          state: 'locked',
          previous: 'active',
          rev: before + 1,
          seq: expect.any(Number),
        });
        // A service credential may change it too; no state change, no new revision.
        const s = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: h.apiKey,
          body: { title: null },
          headers: { 'If-Match': '"m2"' },
        });
        expect(s.json.title).toBeNull();
        expect((await h.parts.grants.current({ tenant: h.tenant, doc })).revision).toBe(before + 1);
      },
    );

    it.skipIf(skip)(
      'lets exactly one of two updates with the same ETag succeed (PRO-042 criterion 5)',
      async () => {
        const doc = await h.createDocument();
        const send = (title: string) =>
          h.call('PATCH', `/v1/documents/${doc}`, {
            token: h.apiKey,
            body: { title },
            headers: { 'If-Match': '"m1"' },
          });
        const results = await Promise.all([send('a'), send('b')]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
        const winner = results.find((r) => r.status === 200)!.json.title;
        expect((await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })).json.title).toBe(
          winner,
        );
      },
    );

    it.skipIf(skip)(
      'soft-deletes with manage or a service credential; the data stays (BE-035 criterion 6)',
      async () => {
        const ext = `del-${randomUUID()}`;
        const doc = await h.createDocument({ externalId: ext });
        problem(
          await h.call('DELETE', `/v1/documents/${doc}`, {
            token: h.userToken({ [doc]: 'editor' }),
          }),
          403,
          'forbidden',
        );
        problem(
          await h.call('DELETE', `/v1/documents/${doc}`, {
            token: h.apiKey,
            headers: { 'If-Match': '"m7"' },
          }),
          412,
          'precondition_failed',
        );
        const r = await h.call('DELETE', `/v1/documents/${doc}`, {
          token: h.userToken({ [doc]: 'owner' }),
        });
        expect(r.status).toBe(204);
        problem(await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey }), 404, 'not_found');
        expect(
          (await h.call('GET', `/v1/documents?externalId=${ext}`, { token: h.apiKey })).json.items,
        ).toEqual([]);
        expect(h.stub.notices.some((n) => n.kind === 'document' && n.ref?.doc === doc)).toBe(true);
        expect(h.events.of('dep.document.deleted.v1').map((e) => e.subject)).toContain(doc);
        const kept = await h.parts.documents.get({ tenant: h.tenant, doc });
        expect(kept?.deletedAt).toBeTypeOf('number');
        expect(await h.service.checkpoints.get({ tenant: h.tenant, doc }, 0)).not.toBeNull();
      },
    );

    it.skipIf(skip)(
      'attributes changes to the DEP-Actor surrogate, to system without one, and ignores it on user tokens (BE-033 criteria 6, 7; BE-013)',
      async () => {
        const a = await h.call('POST', '/v1/documents', {
          token: h.apiKey,
          body: {},
          headers: { 'DEP-Actor': 'dave' },
        });
        const dave = (await h.parts.users.resolve(h.tenant, 'dave')).surrogate;
        expect((await h.parts.documents.get({ tenant: h.tenant, doc: a.json.id }))!.createdBy).toBe(
          dave,
        );
        expect(dave).not.toBe('dave');
        const b = await h.call('POST', '/v1/documents', { token: h.apiKey, body: {} });
        expect((await h.parts.documents.get({ tenant: h.tenant, doc: b.json.id }))!.createdBy).toBe(
          'system',
        );
        problem(
          await h.call('POST', '/v1/documents', {
            token: h.apiKey,
            body: {},
            headers: { 'DEP-Actor': 'has space' },
          }),
          400,
          'validation_failed',
        );
        // With a user token the header is ignored: the change is the user's (attribution of grant
        // changes is checked against PostgreSQL in routes.content.test.ts).
        const doc = b.json.id as string;
        const r = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: h.userToken({ [doc]: 'owner' }),
          body: { state: 'archived' },
          headers: { 'If-Match': '"m1"', 'DEP-Actor': 'mallory' },
        });
        expect(r.status).toBe(200);
      },
    );
  });
}
