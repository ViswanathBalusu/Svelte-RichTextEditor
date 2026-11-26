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
  '/tenants',
  '/tenants/{tenantId}',
  '/usage',
  '/sealing-keys',
] as const;

/** The routes an operator credential manages (decision 68); every other administration route is a tenant administrator's. */
const OPERATOR_PATHS: readonly string[] = ['/tenants', '/tenants/{tenantId}'];

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
        'listTenants',
        'createTenant',
        'getTenant',
        'updateTenant',
        'getTenantUsage',
        'listSealingKeys',
      ]),
    );
  });

  it('defines every resource of 13 section 10: tenants, usage figures and both kinds of signing key (criterion 1)', () => {
    for (const word of [
      'tenants',
      'usage',
      'keys',
      'sealing-keys',
      'origins',
      'quotas',
      'fonts',
      'retention',
      'webhooks',
    ])
      expect(
        Object.keys(paths).some((p) => p.toLowerCase().includes(word)),
        word,
      ).toBe(true);
    expect(Object.keys(paths['/tenants']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/tenants/{tenantId}']!).sort()).toEqual(['get', 'patch']);
    expect(Object.keys(paths['/usage']!)).toEqual(['get']);
    // The token keys and the PDF sealing keys are separate sections (decision 112).
    expect(Object.keys(paths['/sealing-keys']!)).toEqual(['get']);
  });

  it('has write routes for the keys and origins, each with a service credential (UX-077)', () => {
    expect(Object.keys(paths['/keys']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/keys/{kid}']!)).toEqual(['delete']);
    expect(Object.keys(paths['/origins']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/origins/{origin}']!)).toEqual(['delete']);
  });
});

describe('UX-076 criterion 3 (the credential half): a user token never grants access', () => {
  it('names the service credential (the tenant administrator) alone on every administration route except the font list and the operator routes', () => {
    for (const r of routes) {
      if (r.path === '/fonts' || OPERATOR_PATHS.includes(r.path)) continue;
      expect(schemeNames(r), name(r)).toEqual(['serviceCredential']);
    }
  });

  it('names the operator credential alone on the tenant routes, so neither a service credential nor a user token grants access', () => {
    const tenant = routes.filter((r) => OPERATOR_PATHS.includes(r.path));
    expect(tenant.map(name).sort()).toEqual([
      'GET /tenants',
      'GET /tenants/{tenantId}',
      'PATCH /tenants/{tenantId}',
      'POST /tenants',
    ]);
    for (const r of tenant) expect(schemeNames(r), name(r)).toEqual(['operatorCredential']);
  });

  it('says in the security schemes who holds each credential (criterion 3)', () => {
    const schemes = (openapi['components'] as Json)['securitySchemes'] as Record<string, Json>;
    expect(String(schemes['serviceCredential']!['description'])).toContain(
      'tenant administrator credential',
    );
    expect(String(schemes['operatorCredential']!['description'])).toContain('every tenant');
    expect(String(schemes['operatorCredential']!['description'])).toContain('a user token');
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

  it('finds the paged lists: webhooks, audit, holds, tenants and sealing keys', () => {
    expect(lists.map(name).sort()).toEqual([
      'GET /audit',
      'GET /holds',
      'GET /sealing-keys',
      'GET /tenants',
      'GET /webhooks',
    ]);
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
