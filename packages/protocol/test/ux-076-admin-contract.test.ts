/**
 * UX-076, read from the published OpenAPI document (spec/dep/dep-1.openapi.json): what the
 * administration contract defines today and where it follows the conventions of the control plane.
 * Idempotency keys, `If-Match` and `ETag` for every route are PRO-002's test; this one covers the
 * administration routes: which resources exist, who may call them, how lists and errors look.
 *
 * It does not claim the criteria of the story. Two resources 13 §10 names (tenants and usage
 * figures) have no definition, and the keys and origins are not paged lists: both are pinned below
 * as they are, so a change shows here (docs/adr/0371-w3-UX-076-admin-api-contract.md).
 */
import { describe, expect, it } from 'vitest';
import { readJson, resolvePointer } from './support.ts';

type Json = Record<string, unknown>;
const openapi = readJson('spec/dep/dep-1.openapi.json') as Json;
/** Follows a `$ref` object to what it names; anything else is returned as it is. */
const deref = (x: unknown): Json => {
  const ref = (x as Json)['$ref'];
  return (typeof ref === 'string' ? resolvePointer(openapi, ref) : x) as Json;
};
const paths = openapi['paths'] as Record<string, Record<string, Json>>;

/** The administration routes (13 §10): the paths a tenant's service credential manages. */
const ADMIN_PATHS = [
  '/webhooks',
  '/webhooks/{id}',
  '/audit',
  '/retention',
  '/documents/{id}/retention',
  '/origins',
  '/origins/{origin}',
  '/keys',
  '/keys/{kid}',
  '/quotas',
  '/documents/{id}/holds',
  '/holds',
  '/fonts',
] as const;

interface Route {
  method: string;
  path: string;
  op: Json;
}
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const routes: Route[] = ADMIN_PATHS.flatMap((path) =>
  Object.entries(paths[path] ?? {})
    .filter(([m]) => METHODS.includes(m))
    .map(([method, op]) => ({ method, path, op })),
);
const name = (r: Route) => `${r.method.toUpperCase()} ${r.path}`;
const params = (r: Route) =>
  ((r.op['parameters'] as Json[] | undefined) ?? []).map((p) => deref(p));
const schemeNames = (r: Route) =>
  ((r.op['security'] as Array<Record<string, unknown>> | undefined) ?? []).flatMap((s) =>
    Object.keys(s),
  );

describe('UX-076: what the administration contract defines', () => {
  it('has an operation for each administration route the story outlines', () => {
    for (const path of ADMIN_PATHS) expect(paths[path], path).toBeDefined();
    const operations = routes.map((r) => r.op['operationId']);
    expect(operations).toEqual(
      expect.arrayContaining([
        'listWebhooks',
        'createWebhook',
        'getWebhook',
        'updateWebhook',
        'deleteWebhook',
        'getAudit',
        'getTenantRetention',
        'setTenantRetention',
        'getDocumentRetention',
        'setDocumentRetention',
        'getTenantOrigins',
        'getTenantKeys',
        'getTenantQuotas',
        'setTenantQuotas',
        'placeHold',
        'listHolds',
        'getFonts',
      ]),
    );
  });

  it('pins the resources of 13 section 10 that have no definition yet: tenants and usage figures', () => {
    const missing = ['tenants', 'usage'].filter(
      (word) => !Object.keys(paths).some((p) => p.toLowerCase().includes(word)),
    );
    expect(missing).toEqual(['tenants', 'usage']);
  });

  it('has write routes for the keys and origins, each with a service credential (UX-077)', () => {
    expect(Object.keys(paths['/keys']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/keys/{kid}']!)).toEqual(['delete']);
    expect(Object.keys(paths['/origins']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/origins/{origin}']!)).toEqual(['delete']);
  });
});

describe('UX-076 criterion 3 (the credential half): a user token never grants access', () => {
  it('names the service credential alone on every administration route except the font list', () => {
    for (const r of routes) {
      if (r.path === '/fonts') continue;
      expect(schemeNames(r), name(r)).toEqual(['serviceCredential']);
    }
  });

  it('lets the user token read the font list only (the editor needs the registry), never write', () => {
    const fonts = routes.filter((r) => r.path === '/fonts');
    expect(fonts.map(name)).toEqual(['GET /fonts']);
    expect(schemeNames(fonts[0]!).sort()).toEqual(['serviceCredential', 'userToken']);
  });
});

describe('UX-076 criterion 2: lists, limits and problem details on the administration routes', () => {
  const lists = routes
    .filter((r) => r.method === 'get' && r.path !== '/fonts')
    .filter((r) => {
      const ok = (r.op['responses'] as Record<string, Json>)['200']!;
      const schema = (ok['content'] as Json)['application/json'] as Json;
      const resolved = deref(schema['schema'] as Json);
      return Object.hasOwn((resolved['properties'] as Json) ?? {}, 'nextCursor');
    });

  it('finds the three paged lists: webhooks, audit and holds', () => {
    expect(lists.map(name).sort()).toEqual(['GET /audit', 'GET /holds', 'GET /webhooks']);
  });

  it('gives each paged list { items, nextCursor }, the cursor and the limit parameters, and a limit of at most 200', () => {
    const limit = (openapi['components'] as Json)['parameters'] as Json;
    expect(((limit['Limit'] as Json)['schema'] as Json)['maximum']).toBe(200);
    for (const r of lists) {
      const names = params(r).map((p) => p['name']);
      expect(names, name(r)).toEqual(expect.arrayContaining(['cursor', 'limit']));
      const ok = (r.op['responses'] as Record<string, Json>)['200']!;
      const schema = ((ok['content'] as Json)['application/json'] as Json)['schema'] as Json;
      const resolved = deref(schema);
      expect(Object.keys(resolved['properties'] as Json), name(r)).toEqual(['items', 'nextCursor']);
    }
  });

  it('pins the keys and origins as single objects, not paged lists (a deviation, ADR 0371)', () => {
    for (const [path, field] of [
      ['/keys', 'keys'],
      ['/origins', 'origins'],
    ] as const) {
      const get = paths[path]!['get']!;
      const ok = (get['responses'] as Record<string, Json>)['200']!;
      const schema = ((ok['content'] as Json)['application/json'] as Json)['schema'] as Json;
      const resolved = deref(schema);
      expect(Object.keys(resolved['properties'] as Json), path).toEqual([field]);
    }
  });

  it('answers every error of every administration route as RFC 9457 problem details', () => {
    for (const r of routes) {
      const responses = r.op['responses'] as Record<string, Json>;
      for (const key of ['4XX', '5XX']) {
        const resolved = deref(responses[key]!);
        expect(Object.keys(resolved['content'] as Json), `${name(r)} ${key}`).toEqual([
          'application/problem+json',
        ]);
      }
    }
  });
});
