/**
 * SEC-016 — a resource named by its own identifier (an export, an asset, a thread, a comment, an
 * import, a webhook) is checked against the document it belongs to, not only against the tenant
 * (10 §3.2; 05 §6.2, §6.1). The routes are read from the OpenAPI definition itself, so a new route
 * with such an identifier shows up in the catalogue check and fails the build until it has a probe
 * (criterion 3).
 *
 * Exports, assets, imports, threads and comments are probed over real HTTP with objects of a second
 * document and of a second tenant. A caller that may not see the resource gets `not_found`, the
 * answer a missing identifier gets, with nothing that tells the two apart (owner decision 57 of
 * 2026-11-15; criterion 4). Webhooks, keys and origins are service-credential resources: a user token
 * is refused on the route, and a credential of another tenant gets `not_found`. Templates, bulk
 * sends and the webhook ping and replay are not composed in this scenario; the story Notes name
 * where they are proven.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';

const SPEC = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../spec/dep/dep-1.openapi.json', import.meta.url)),
    'utf8',
  ),
) as { paths: Record<string, Record<string, unknown>> };

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every route whose path names a resource by its own identifier, not under a document. */
export function bareRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(SPEC.paths)) {
    if (!path.includes('{') || path.startsWith('/documents/{id}')) continue;
    // The tenant routes take the operator credential alone (decision 68): no user token or tenant
    // credential reaches them, so no identifier of another tenant can be tried (row 14 of the kit).
    if (path.startsWith('/tenants/')) continue;
    for (const m of METHODS) if (m in item) out.push(`${m.toUpperCase()} ${path}`);
  }
  return out.sort();
}

/** The workflow participant routes: a participant is named under a document, not by itself. */
export function bareParticipantRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(SPEC.paths)) {
    if (!path.includes('/participants/{pid}')) continue;
    for (const m of METHODS) if (m in item) out.push(`${m.toUpperCase()} ${path}`);
  }
  return out.sort();
}
/** The probe each such route has: served and probed here, or not served yet (a missing route). */
const CATALOGUE: Record<string, 'probed' | 'not-served'> = {
  'GET /exports/{jid}': 'probed',
  'DELETE /exports/{jid}': 'probed',
  'POST /assets/{aid}/complete': 'probed',
  // The tenant registry (UX-077): a key and an origin belong to a tenant, not to a document.
  'DELETE /keys/{kid}': 'probed',
  'DELETE /origins/{origin}': 'probed',
  // BE-048: a font a tenant added is named by its hash, in the tenant's own prefix.
  'GET /tenant-fonts/{sha256}': 'probed',
  'DELETE /tenant-fonts/{sha256}': 'probed',
  'GET /imports/{jid}': 'probed',
  'GET /threads/{tid}': 'probed',
  'PATCH /threads/{tid}': 'probed',
  'DELETE /threads/{tid}': 'probed',
  'POST /threads/{tid}/comments': 'probed',
  'PATCH /comments/{cid}': 'probed',
  'DELETE /comments/{cid}': 'probed',
  'POST /comments/{cid}/reactions/{reaction}': 'probed',
  'DELETE /comments/{cid}/reactions/{reaction}': 'probed',
  'GET /webhooks/{id}': 'probed',
  'PATCH /webhooks/{id}': 'probed',
  'DELETE /webhooks/{id}': 'probed',
  // UX-079 (ADR 0330 section 2): the test-ping and the replay of one delivery name a webhook by its own identifier.
  'POST /webhooks/{id}/ping': 'not-served',
  'POST /webhooks/{id}/deliveries/{deliveryId}/replay': 'not-served',
  // FRW-062, FRW-063: the handlers exist, but this scenario composes no template store, so a
  // template and a bulk send answer as a missing route do. Their tenant scope is in
  // frw-062.tenant-scope.test.ts and the sweep of sec-045-route-sweep.test.ts.
  'GET /templates/{tid}': 'not-served',
  'GET /bulk-sends/{bid}': 'not-served',
};

const withId = (route: string, ids: Record<string, string>) =>
  route.replace(/\{(\w+)\}/g, (_, name: string) => ids[name] ?? randomUUID());

/** A refused answer reveals no data: no job state, no target, no asset fields. */
const noData = (json: unknown) => {
  const j = (json ?? {}) as Record<string, unknown>;
  for (const k of ['state', 'target', 'filename', 'mime', 'uploadUrl', 'id'])
    expect(j[k], `refused answer must not carry ${k}`).toBeUndefined();
};

describe('SEC-016 catalogue of bare-identifier routes', () => {
  it('lists every route whose identifier is not under a document, and has a probe for it', () => {
    // A new route in the definition fails here until it is added to CATALOGUE and probed.
    expect(bareRoutes()).toEqual(Object.keys(CATALOGUE).sort());
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-016 resources cannot be reached by bare identifier (${storage})`, () => {
    let h: Harness;
    let docA: string; // tenant A, the caller's document
    let docB: string; // tenant A, another document of the same tenant
    let jidB: string; // an export of docB
    let aidB: string; // an asset of docB
    let docBB: string; // tenant B's document
    let jidBB: string; // an export of tenant B
    let aidBB: string; // an asset of tenant B
    let tokenA: string; // a user token for docA only (editor)
    let ownerB: string; // an owner token for docB (tenant A)
    let ownerBB: string; // an owner token for tenant B's document
    let tidB: string; // a thread of docB
    let cidB: string; // a comment of that thread
    let impB: string; // an import job of docB
    let tidBB: string; // a thread of tenant B
    let cidBB: string; // a comment of tenant B's thread
    let impBB: string; // an import job of tenant B
    let hookBB: string; // a webhook of tenant B

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        parts: {
          webhooks: new WebhookSubscriptions({
            store: new MemorySubscriptionStore(),
            now: () => Date.now(),
          }),
        },
      });
      docA = await h.createDocument(h.a, documentWithRegions());
      docB = await h.createDocument(h.a, documentWithRegions());
      docBB = await h.createDocument(h.b, documentWithRegions());
      tokenA = h.userToken(h.a, 'ann', { [docA]: 'editor' });
      const ex = (doc: string, key: string) =>
        h.call('POST', `/v1/documents/${doc}/exports`, { token: key, body: { target: 'pdf' } });
      const asset = (doc: string, key: string) =>
        h.call('POST', `/v1/documents/${doc}/assets`, {
          token: key,
          body: { filename: 'picture.png', mime: 'image/png', size: 16 },
        });
      const [eB, aB, eBB, aBB] = await Promise.all([
        ex(docB, h.a.apiKey),
        asset(docB, h.a.apiKey),
        ex(docBB, h.b.apiKey),
        asset(docBB, h.b.apiKey),
      ]);
      jidB = eB!.json?.id as string;
      aidB = aB!.json?.asset as string;
      jidBB = eBB!.json?.id as string;
      aidBB = aBB!.json?.asset as string;
      // Each probe below is meaningful only if the resource it attacks exists.
      expect([eB!.status, aB!.status, eBB!.status, aBB!.status]).toEqual([202, 201, 202, 201]);
      // An identifier that is not there would make every probe below prove nothing.
      for (const id of [jidB, aidB, jidBB, aidBB]) expect(typeof id).toBe('string');
      // Threads, comments and import jobs of the same two places, made by their own owners.
      ownerB = await h.mintToken(h.a, 'bob', { [docB]: 'owner' });
      ownerBB = await h.mintToken(h.b, 'bella', { [docBB]: 'owner' });
      const thread = async (doc: string, token: string) => {
        const th = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token,
          body: {
            target: { block: 'pIntro0000000001' },
            comment: { body: [{ type: 'text', text: 'private thread' }] },
          },
        });
        expect(th.status, th.text.slice(0, 200)).toBeLessThan(300);
        const reply = await h.call('POST', `/v1/threads/${th.json?.id}/comments`, {
          token,
          body: { body: [{ type: 'text', text: 'private reply' }] },
        });
        expect(reply.status, reply.text.slice(0, 200)).toBeLessThan(300);
        return { tid: th.json?.id as string, cid: reply.json?.id as string };
      };
      ({ tid: tidB, cid: cidB } = await thread(docB, ownerB));
      ({ tid: tidBB, cid: cidBB } = await thread(docBB, ownerBB));
      // This scenario composes no importer, so the jobs are put in the queue as the route would.
      const job = async (tenant: string, doc: string, createdBy: string) =>
        (
          await h.parts.queue.enqueue(tenant, {
            kind: 'import',
            doc,
            createdBy,
            maxAttempts: 1,
            payload: { doc, asset: randomUUID(), format: 'docx' },
          })
        ).id;
      // The actor of a user token is a surrogate of its sub; a job of the owner carries it.
      const actorOf = async (tenant: string, doc: string, token: string) => {
        const e = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token,
          body: { target: 'pdf' },
        });
        return (await h.parts.queue.get(tenant, e.json?.id as string))!.createdBy;
      };
      impB = await job(h.a.id, docB, await actorOf(h.a.id, docB, ownerB));
      impBB = await job(h.b.id, docBB, await actorOf(h.b.id, docBB, ownerBB));
      const hook = await h.call('POST', '/v1/webhooks', {
        token: h.b.apiKey,
        body: {
          url: 'https://hooks.example.test/sec-016-tenant-b',
          events: ['dep.grants.changed.v1'],
        },
      });
      expect(hook.status, hook.text.slice(0, 200)).toBeLessThan(300);
      hookBB = hook.json?.id as string;
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()('the resources the probes attack exist, and their owner can read them', async () => {
      const owner = await h.call('GET', `/v1/exports/${jidB}`, { token: h.a.apiKey });
      expect(owner.status).toBe(200);
      expect(typeof owner.json?.state).toBe('string');
    });

    t()(
      'a token for document A cannot read, cancel or complete an export or an asset of document B',
      async () => {
        const read = await h.call('GET', `/v1/exports/${jidB}`, { token: tokenA });
        expect([403, 404]).toContain(read.status);
        noData(read.json);

        const cancel = await h.call('DELETE', `/v1/exports/${jidB}`, { token: tokenA });
        expect([403, 404]).toContain(cancel.status);

        const complete = await h.call('POST', `/v1/assets/${aidB}/complete`, { token: tokenA });
        expect([403, 404]).toContain(complete.status);
        noData(complete.json);

        // The cancel did not land: the owner still sees the export as it was.
        const after = await h.call('GET', `/v1/exports/${jidB}`, { token: h.a.apiKey });
        expect(after.json?.state).not.toBe('cancelled');
      },
    );

    /**
     * What a refused call and a call for an identifier that names nothing must share: the status and
     * the whole problem body, once the identifier the caller sent is taken out of the text.
     */
    const same = (refused: CallResult, missing: CallResult, sent: string, gone: string) => {
      expect(refused.status).toBe(404);
      expect(missing.status).toBe(404);
      const shape = (r: CallResult, id: string) =>
        r.text
          .split(id)
          .join('<id>')
          .replace(/"(instance|requestId|traceId)":"[^"]*"/g, '');
      expect(shape(refused, sent)).toBe(shape(missing, gone));
      expect(refused.headers.get('content-type')).toBe(missing.headers.get('content-type'));
    };

    t()(
      'a refused request and a request for a missing identifier get the same answer, not_found (criterion 4; owner decision 57)',
      async () => {
        const missing = randomUUID();
        // The same call, once for an object the caller may not see and once for one that is not there:
        // a token for another document of the tenant, and a credential of another tenant.
        const probes: Array<[string, string, string, string, unknown?]> = [
          ['GET', `/v1/exports/${jidB}`, '/v1/exports/', jidB],
          ['DELETE', `/v1/exports/${jidB}`, '/v1/exports/', jidB],
          ['POST', `/v1/assets/${aidB}/complete`, '/v1/assets/', aidB],
          ['GET', `/v1/imports/${impB}`, '/v1/imports/', impB],
          ['GET', `/v1/threads/${tidB}`, '/v1/threads/', tidB],
          ['PATCH', `/v1/threads/${tidB}`, '/v1/threads/', tidB, { state: 'resolved' }],
          ['DELETE', `/v1/threads/${tidB}`, '/v1/threads/', tidB],
          [
            'POST',
            `/v1/threads/${tidB}/comments`,
            '/v1/threads/',
            tidB,
            { body: [{ type: 'text', text: 'hello' }] },
          ],
          [
            'PATCH',
            `/v1/comments/${cidB}`,
            '/v1/comments/',
            cidB,
            { body: [{ type: 'text', text: 'changed' }] },
          ],
          ['DELETE', `/v1/comments/${cidB}`, '/v1/comments/', cidB],
          ['POST', `/v1/comments/${cidB}/reactions/thumbsUp`, '/v1/comments/', cidB],
          ['DELETE', `/v1/comments/${cidB}/reactions/thumbsUp`, '/v1/comments/', cidB],
        ];
        for (const [method, path, prefix, id, body] of probes) {
          const absent = (suffix: string) => prefix + missing + suffix;
          const suffix = path.slice((prefix + id).length);
          for (const [who, token] of [
            ['a token for another document', tokenA],
            ['a credential of another tenant', h.b.apiKey],
          ] as const) {
            // Tenant B's credential names tenant A's object: the tenant scope hides it the same way.
            const refused = await h.call(method, path, { token, ...(body ? { body } : {}) });
            const none = await h.call(method, absent(suffix), { token, ...(body ? { body } : {}) });
            same(refused, none, id, missing);
            noData(refused.json);
            expect(refused.text, `${method} ${path} by ${who}`).not.toContain('private');
          }
        }
        // The same for tenant A's credential and a thread, comment and import of tenant B.
        for (const [method, path, id, prefix, body] of [
          ['GET', `/v1/threads/${tidBB}`, tidBB, '/v1/threads/', undefined],
          [
            'PATCH',
            `/v1/comments/${cidBB}`,
            cidBB,
            '/v1/comments/',
            { body: [{ type: 'text', text: 'changed' }] },
          ],
          ['GET', `/v1/imports/${impBB}`, impBB, '/v1/imports/', undefined],
        ] as const) {
          const refused = await h.call(method, path, {
            token: h.a.apiKey,
            ...(body ? { body } : {}),
          });
          const none = await h.call(method, prefix + missing, {
            token: h.a.apiKey,
            ...(body ? { body } : {}),
          });
          same(refused, none, id, missing);
        }
      },
    );

    t()(
      'a token for document A cannot read, change, cancel or complete the threads, comments or imports of document B (criterion 1)',
      async () => {
        const attacks: Array<[string, string, unknown?]> = [
          ['GET', `/v1/threads/${tidB}`],
          ['PATCH', `/v1/threads/${tidB}`, { state: 'resolved' }],
          ['DELETE', `/v1/threads/${tidB}`],
          ['POST', `/v1/threads/${tidB}/comments`, { body: [{ type: 'text', text: 'injected' }] }],
          ['PATCH', `/v1/comments/${cidB}`, { body: [{ type: 'text', text: 'injected' }] }],
          ['DELETE', `/v1/comments/${cidB}`],
          ['POST', `/v1/comments/${cidB}/reactions/thumbsUp`],
          ['GET', `/v1/imports/${impB}`],
        ];
        for (const [method, path, body] of attacks) {
          // Without an If-Match too: a missing precondition must not tell that the object exists.
          const r = await h.call(method, path, { token: tokenA, ...(body ? { body } : {}) });
          expect(r.status, `${method} ${path}`).toBe(404);
          noData(r.json);
          const ifMatch = await h.call(method, path, {
            token: tokenA,
            headers: { 'If-Match': '"1"' },
            ...(body ? { body } : {}),
          });
          expect(ifMatch.status, `${method} ${path} with If-Match`).toBe(404);
        }
        // Nothing landed: the owner reads the thread as it was, with its two comments.
        const thread = await h.call('GET', `/v1/threads/${tidB}`, { token: ownerB });
        expect(thread.status).toBe(200);
        expect(thread.json?.state).toBe('open');
        const listed = await h.call('GET', `/v1/documents/${docB}/threads`, { token: ownerB });
        expect(listed.json?.items).toHaveLength(1);
        expect(listed.text).not.toContain('injected');
        const job = await h.call('GET', `/v1/imports/${impB}`, { token: ownerB });
        expect(job.status).toBe(200);
      },
    );

    t()(
      "a credential of tenant A cannot read, change or delete tenant B's threads, comments, imports or webhooks, and tenant B can (criterion 2)",
      async () => {
        const attacks: Array<[string, string, unknown?]> = [
          ['GET', `/v1/threads/${tidBB}`],
          ['PATCH', `/v1/threads/${tidBB}`, { state: 'resolved' }],
          ['DELETE', `/v1/threads/${tidBB}`],
          ['POST', `/v1/threads/${tidBB}/comments`, { body: [{ type: 'text', text: 'injected' }] }],
          ['PATCH', `/v1/comments/${cidBB}`, { body: [{ type: 'text', text: 'injected' }] }],
          ['DELETE', `/v1/comments/${cidBB}`],
          ['GET', `/v1/imports/${impBB}`],
          ['GET', `/v1/webhooks/${hookBB}`],
          ['PATCH', `/v1/webhooks/${hookBB}`, { url: 'https://evil.example.test/steal' }],
          ['DELETE', `/v1/webhooks/${hookBB}`],
        ];
        for (const [method, path, body] of attacks) {
          const r = await h.call(method, path, {
            token: h.a.apiKey,
            headers: { 'If-Match': '*' },
            ...(body ? { body } : {}),
          });
          expect(r.status, `${method} ${path}`).toBe(404);
          noData(r.json);
          expect(r.text).not.toContain('private');
          expect(r.text).not.toContain('sec-016-tenant-b');
          // A user token for tenant A's document is no better placed.
          const user = await h.call(method, path, { token: tokenA, ...(body ? { body } : {}) });
          expect([403, 404], `${method} ${path} by a user token`).toContain(user.status);
          noData(user.json);
        }
        // Webhooks are a service-credential resource: a user token is refused on the route itself.
        for (const method of ['GET', 'DELETE'] as const) {
          const r = await h.call(method, `/v1/webhooks/${hookBB}`, { token: tokenA });
          expect(r.status).toBe(403);
        }
        // Tenant B's objects are as they were, and tenant B reads them.
        const thread = await h.call('GET', `/v1/threads/${tidBB}`, { token: ownerBB });
        expect(thread.status).toBe(200);
        expect(thread.json?.state).toBe('open');
        const listed = await h.call('GET', `/v1/documents/${docBB}/threads`, { token: ownerBB });
        expect(listed.json?.items).toHaveLength(1);
        expect(listed.text).not.toContain('injected');
        expect((await h.call('GET', `/v1/imports/${impBB}`, { token: ownerBB })).status).toBe(200);
        const hook = await h.call('GET', `/v1/webhooks/${hookBB}`, { token: h.b.apiKey });
        expect(hook.status).toBe(200);
        expect(JSON.stringify(hook.json)).toContain('sec-016-tenant-b');
      },
    );

    t()(
      'service-credential routes with a bare identifier and the workflow participant routes refuse a token for document A (criterion 1)',
      async () => {
        // Templates, bulk sends and the webhook ping and replay name a resource of the tenant, and
        // only a service credential reaches them: a user token is refused whatever the identifier.
        const service: Array<[string, string]> = [
          ['GET', `/v1/templates/${randomUUID()}`],
          ['GET', `/v1/bulk-sends/${randomUUID()}`],
          ['POST', `/v1/webhooks/${hookBB}/ping`],
          ['POST', `/v1/webhooks/${hookBB}/deliveries/${randomUUID()}/replay`],
        ];
        for (const [method, path] of service) {
          const body = method === 'GET' ? {} : { body: {} };
          const user = await h.call(method, path, { token: tokenA, ...body });
          expect([403, 404], `${method} ${path} by a user token`).toContain(user.status);
          noData(user.json);
          // Tenant A's credential on tenant B's webhook is not found.
          if (path.includes('/webhooks/')) {
            const other = await h.call(method, path, { token: h.a.apiKey, ...body });
            expect(other.status, `${method} ${path} by tenant A`).toBe(404);
            noData(other.json);
          }
        }
        // The participant routes sit under a document: a token for document A names document B.
        const participant = bareParticipantRoutes();
        expect(participant.length).toBeGreaterThan(0);
        for (const route of participant) {
          const [method, template] = route.split(' ') as [string, string];
          const path = '/v1' + withId(template, { id: docB, pid: 'participant-1' });
          const r = await h.call(method, path, {
            token: tokenA,
            ...(method === 'GET' ? {} : { body: {} }),
          });
          // The routes a participant token uses answer a user token as an unknown route would.
          expect([403, 404], `${route}`).toContain(r.status);
          noData(r.json);
        }
      },
    );
    t()(
      "a requester's own job and a job of another requester: the other requester's is not found, the same as a missing one",
      async () => {
        // Same tenant, same document, a second user: D69 (an export job belongs to its requester).
        const other = await h.mintToken(h.a, 'carol', { [docB]: 'owner' });
        const missing = randomUUID();
        for (const [path, id, none] of [
          [`/v1/exports/${jidB}`, jidB, `/v1/exports/${missing}`],
          [`/v1/imports/${impB}`, impB, `/v1/imports/${missing}`],
        ] as const) {
          const refused = await h.call('GET', path, { token: other });
          const absent = await h.call('GET', none, { token: other });
          same(refused, absent, id, missing);
        }
        // The service credential still reads them (the control).
        expect((await h.call('GET', `/v1/imports/${impB}`, { token: h.a.apiKey })).status).toBe(
          200,
        );
      },
    );

    t()(
      "a credential of tenant A cannot reach tenant B's export or asset, and tenant B's owner still can",
      async () => {
        for (const [method, path] of [
          ['GET', `/v1/exports/${jidBB}`],
          ['DELETE', `/v1/exports/${jidBB}`],
          ['POST', `/v1/assets/${aidBB}/complete`],
        ] as const) {
          const r = await h.call(method, path, { token: h.a.apiKey });
          expect([403, 404], `${method} ${path}`).toContain(r.status);
          noData(r.json);
        }
        const stillThere = await h.call('GET', `/v1/exports/${jidBB}`, { token: h.b.apiKey });
        expect(stillThere.status).toBe(200);
        expect(stillThere.json?.state).not.toBe('cancelled');
      },
    );

    t()(
      "a credential of tenant A cannot remove tenant B's key or origin, and a document token cannot remove its own tenant's",
      async () => {
        const kidB = `host-${h.b.id}`;
        const originB = encodeURIComponent(h.b.origin);
        const own = await h.call('GET', '/v1/keys', { token: h.b.apiKey });
        expect(own.status).toBe(200);
        expect(JSON.stringify(own.json)).toContain(kidB);

        const key = await h.call('DELETE', `/v1/keys/${kidB}`, { token: h.a.apiKey });
        expect([403, 404]).toContain(key.status);
        const origin = await h.call('DELETE', `/v1/origins/${originB}`, { token: h.a.apiKey });
        expect([403, 404]).toContain(origin.status);

        // A user token for one document is not a service credential: it removes nothing of tenant A.
        const kidA = `host-${h.a.id}`;
        const asUser = await h.call('DELETE', `/v1/keys/${kidA}`, { token: tokenA });
        expect(asUser.status).toBe(403);
        const asUserOrigin = await h.call(
          'DELETE',
          `/v1/origins/${encodeURIComponent(h.a.origin)}`,
          { token: tokenA },
        );
        expect(asUserOrigin.status).toBe(403);

        // Nothing landed: tenant B still has its key and its origin, tenant A its own.
        const after = await h.call('GET', '/v1/keys', { token: h.b.apiKey });
        expect(JSON.stringify(after.json)).toContain(kidB);
        const originsB = await h.call('GET', '/v1/origins', { token: h.b.apiKey });
        expect(JSON.stringify(originsB.json)).toContain(h.b.origin);
        const keysA = await h.call('GET', '/v1/keys', { token: h.a.apiKey });
        expect(JSON.stringify(keysA.json)).toContain(kidA);
      },
    );

    t()(
      "a credential of tenant A cannot read or remove tenant B's font, and a user token cannot remove its own tenant's",
      async () => {
        const bytes = new TextEncoder().encode('font bytes of tenant B');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await h.parts.objects.put(`tenants/${h.b.id}/fonts/${sha256}`, bytes);
        await h.parts.tenantFonts!.add({
          tenant: h.b.id,
          sha256,
          family: 'Bare Sans',
          style: 'regular',
          weight: 400,
          italic: false,
          format: 'truetype',
          bytes: bytes.length,
          licence: 'Test licence',
          serverUse: true,
          addedBy: 'bare-identifiers',
          addedAt: 1,
        });
        const own = await h.call('GET', `/v1/tenant-fonts/${sha256}`, { token: h.b.apiKey });
        expect(own.status).toBe(200);
        const read = await h.call('GET', `/v1/tenant-fonts/${sha256}`, { token: h.a.apiKey });
        expect(read.status).toBe(404);
        expect(read.text).not.toContain(sha256.slice(8, 40));
        const del = await h.call('DELETE', `/v1/tenant-fonts/${sha256}`, { token: h.a.apiKey });
        expect(del.status).toBe(404);
        const asUser = await h.call('DELETE', `/v1/tenant-fonts/${sha256}`, { token: tokenA });
        expect(asUser.status).toBe(403);
        // Nothing landed: the font and its file are still tenant B's.
        const after = await h.call('GET', `/v1/tenant-fonts/${sha256}`, { token: h.b.apiKey });
        expect(after.status).toBe(200);
      },
    );

    t()(
      'routes not served by this build answer as a missing route does (listed in CATALOGUE)',
      async () => {
        // When one of these routes is served, move it to 'probed' and add its probe: this assertion
        // then fails on purpose.
        for (const route of bareRoutes().filter((r) => CATALOGUE[r] === 'not-served')) {
          const [method, template] = route.split(' ') as [string, string];
          const r = await h.call(method, withId(template, {}), {
            token: h.a.apiKey,
            ...(method === 'POST' || method === 'PATCH' ? { body: {} } : {}),
          });
          expect(r.status, route).toBe(404);
        }
      },
    );
  });
}
