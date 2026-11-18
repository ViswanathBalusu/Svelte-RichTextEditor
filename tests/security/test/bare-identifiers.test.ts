/**
 * SEC-016 — a resource named by its own identifier (an export, an asset, a thread, a comment, an
 * import, a webhook) is checked against the document it belongs to, not only against the tenant
 * (10 §3.2; 05 §6.2, §6.1). The routes are read from the OpenAPI definition itself, so a new route
 * with such an identifier shows up in the catalogue check and fails the build until it has a probe
 * (criterion 3).
 *
 * Phase-1b scope: exports and assets are served by this build and are probed over real HTTP. Threads,
 * comments, imports and webhooks are in the definition but not served yet; their probes assert the
 * refusal a missing route gives, and the story Notes say so.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
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
  'GET /imports/{jid}': 'not-served',
  'GET /threads/{tid}': 'not-served',
  'PATCH /threads/{tid}': 'not-served',
  'DELETE /threads/{tid}': 'not-served',
  'POST /threads/{tid}/comments': 'not-served',
  'PATCH /comments/{cid}': 'not-served',
  'DELETE /comments/{cid}': 'not-served',
  'GET /webhooks/{id}': 'not-served',
  'PATCH /webhooks/{id}': 'not-served',
  'DELETE /webhooks/{id}': 'not-served',
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

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
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
      aidB = aB!.json?.id as string;
      jidBB = eBB!.json?.id as string;
      aidBB = aBB!.json?.id as string;
      // Each probe below is meaningful only if the resource it attacks exists.
      expect([eB!.status, aB!.status, eBB!.status, aBB!.status]).toEqual([202, 201, 202, 201]);
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

    t()(
      'a foreign export and a missing one differ today: 403 against 404 (open question, pinned)',
      async () => {
        // Whether a refused request must look like a missing one is the open question on
        // `forbidden` and `not_found` (SEC-016 criterion 4; the register of open questions in the
        // epic). No spec default decides it, so this test pins the current answer. A decision changes
        // these expectations on purpose; it is not an assertion that the difference is correct.
        const missing = randomUUID();
        for (const method of ['GET', 'DELETE'] as const) {
          const foreign = await h.call(method, `/v1/exports/${jidB}`, { token: tokenA });
          const absent = await h.call(method, `/v1/exports/${missing}`, { token: tokenA });
          expect(foreign.status, `${method} foreign`).toBe(403);
          expect(absent.status, `${method} missing`).toBe(404);
        }
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
