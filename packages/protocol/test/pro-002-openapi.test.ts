/**
 * PRO-002, criteria 2 and 3, read from the published OpenAPI document itself (not from the
 * definition's own flags, so a route that forgets a flag is caught).
 *
 * - Criterion 2: every POST that answers `201` declares `Idempotency-Key`; every PUT and PATCH
 *   requires `If-Match`, and its GET answers with an `ETag`.
 * - Criterion 3: every route names the user token, the service credential or both, and the
 *   service-credential-only routes are exactly the routes of the `service` row of the
 *   authorisation matrix of PRM-056 (`spec/permissions/permissions-1.json`, 07 §12).
 */
import { describe, expect, it } from 'vitest';
import { readJson, resolvePointer } from './support.ts';

type Json = Record<string, unknown>;
interface Operation {
  route: string;
  method: string;
  path: string;
  op: Json;
  params: Json[];
  responses: Record<string, Json>;
  schemes: string[][];
}

const openapi = readJson('spec/dep/dep-1.openapi.json') as Json;
const permissions = readJson('spec/permissions/permissions-1.json') as {
  matrix: Array<{ id: string; requirement: { kind: string }; routes: string[] }>;
  unmatrixedRoutes: Array<{ route: string; class: string }>;
};

const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const deref = (v: Json): Json =>
  '$ref' in v ? (resolvePointer(openapi, v['$ref'] as string) as Json) : v;

const operations: Operation[] = Object.entries(openapi['paths'] as Record<string, Json>).flatMap(
  ([path, item]) =>
    METHODS.filter((m) => m in item).map((m) => {
      const op = item[m] as Json;
      return {
        route: `${m.toUpperCase()} ${path}`,
        method: m,
        path,
        op,
        params: ((op['parameters'] as Json[] | undefined) ?? []).map(deref),
        responses: Object.fromEntries(
          Object.entries(op['responses'] as Record<string, Json>).map(([k, v]) => [k, deref(v)]),
        ),
        schemes: ((op['security'] as Json[] | undefined) ?? []).map((s) => Object.keys(s)),
      };
    }),
);
const header = (o: Operation, name: string): Json | undefined =>
  o.params.find((p) => p['in'] === 'header' && p['name'] === name);

describe('the OpenAPI document: conditional and idempotent requests (PRO-002 criterion 2)', () => {
  it('reads operations from the document', () => {
    expect(operations.length).toBeGreaterThan(50);
  });

  it('declares Idempotency-Key on every POST that creates something (answers 201)', () => {
    const creating = operations.filter((o) => o.method === 'post' && '201' in o.responses);
    expect(creating.map((o) => o.route)).toContain('POST /documents/{id}/holds');
    expect(creating.filter((o) => !header(o, 'Idempotency-Key')).map((o) => o.route)).toEqual([]);
  });

  it('requires If-Match on every PUT and PATCH', () => {
    const updates = operations.filter((o) => o.method === 'put' || o.method === 'patch');
    expect(updates.length).toBeGreaterThan(0);
    expect(
      updates.filter((o) => header(o, 'If-Match')?.['required'] !== true).map((o) => o.route),
    ).toEqual([]);
  });

  it('answers the GET of every resource that can be updated with an ETag', () => {
    const missing: string[] = [];
    for (const u of operations.filter((o) => o.method === 'put' || o.method === 'patch')) {
      const get = operations.find((o) => o.method === 'get' && o.path === u.path);
      const etagOn = (o: Operation): boolean =>
        Object.entries(o.responses).some(
          ([status, r]) => status.startsWith('2') && 'ETag' in ((r['headers'] ?? {}) as Json),
        );
      // The client needs the tag before its next update: from the resource's GET, or, for a
      // resource with no GET of its own, from the answer to the update itself.
      if (get ? !etagOn(get) : !etagOn(u)) missing.push(get ? get.route : `${u.route} (no GET)`);
    }
    expect(missing).toEqual([]);
  });
});

describe('the OpenAPI document: credentials of every route (PRO-002 criterion 3)', () => {
  const SCHEMES = ['userToken', 'serviceCredential'];
  const serviceOnly = (o: Operation): boolean =>
    o.schemes.length > 0 && o.schemes.every((s) => s.length === 1 && s[0] === 'serviceCredential');
  const publicRoutes = permissions.unmatrixedRoutes
    .filter((r) => r.class === 'public')
    .map((r) => r.route);

  it('names the user token, the service credential or both on every route but discovery', () => {
    expect(Object.keys((openapi['components'] as Json)['securitySchemes'] as Json).sort()).toEqual(
      [...SCHEMES].sort(),
    );
    for (const o of operations) {
      if (publicRoutes.includes(o.route)) {
        expect(o.schemes, o.route).toEqual([]);
        continue;
      }
      expect(o.schemes.length, o.route).toBeGreaterThan(0);
      for (const s of o.schemes) {
        expect(s.length, o.route).toBe(1);
        expect(SCHEMES, o.route).toContain(s[0]);
      }
      // Never the user token alone: the service credential may act on every route (05 §6.1).
      expect(
        o.schemes.some((s) => s[0] === 'serviceCredential'),
        o.route,
      ).toBe(true);
    }
  });

  it('marks as service credential only exactly the routes of the service row of the matrix', () => {
    const row = permissions.matrix.filter((r) => r.requirement.kind === 'service');
    expect(row.length).toBe(1);
    const expected = [...row[0]!.routes].sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(
      operations
        .filter(serviceOnly)
        .map((o) => o.route)
        .sort(),
    ).toEqual(expected);
  });

  it('accepts the user token on every route of every other row and classification', () => {
    const userRoutes = [
      ...permissions.matrix
        .filter((r) => r.requirement.kind !== 'service')
        .flatMap((r) => r.routes),
      ...permissions.unmatrixedRoutes.filter((r) => r.class !== 'public').map((r) => r.route),
    ];
    expect(userRoutes.length).toBeGreaterThan(0);
    const byRoute = new Map(operations.map((o) => [o.route, o]));
    for (const route of userRoutes) {
      const o = byRoute.get(route);
      expect(o, route).toBeDefined();
      expect(
        o!.schemes.some((s) => s[0] === 'userToken'),
        route,
      ).toBe(true);
    }
    // And no route is left out of the comparison.
    const covered = new Set([
      ...userRoutes,
      ...permissions.matrix.flatMap((r) => r.routes),
      ...publicRoutes,
    ]);
    expect(operations.map((o) => o.route).filter((r) => !covered.has(r))).toEqual([]);
  });
});
