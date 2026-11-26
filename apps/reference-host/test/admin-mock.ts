/**
 * A mock of the published administration API (UX-089). It is built from
 * spec/dep/dep-1.openapi.json: a request is answered only if its method and path are an operation
 * of that file, and every other request gets `not_found` and is recorded in `unpublished`. So a
 * console that runs against it uses no endpoint that the published contract does not have. The
 * state is in memory; the answers follow the conventions of 05 §6.1 (problem details, ETag and
 * If-Match, `{ items, nextCursor }`).
 *
 * Credentials: `service-ok` is a service credential and `operator-ok` an operator credential; a
 * route takes the one its operation names in the file (`security`). Any other bearer value is a user
 * token or a stranger's, and is refused with `forbidden`; no bearer at all is `unauthenticated`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MOCK_BASE = 'https://dep.example.test/v1';
export const SERVICE_CREDENTIAL = 'service-ok';
export const OPERATOR_CREDENTIAL = 'operator-ok';

interface Spec {
  paths: Record<
    string,
    Record<string, { operationId?: string; parameters?: unknown[]; security?: object[] }>
  >;
}
interface Route {
  method: string;
  template: string;
  operationId: string;
  pattern: RegExp;
  names: string[];
  requiresIfMatch: boolean;
  /** The operation names the operator credential, not the tenant's service credential. */
  operator: boolean;
}
type Json = Record<string, unknown>;

const specPath = fileURLToPath(new URL('../../../spec/dep/dep-1.openapi.json', import.meta.url));

function routesOf(spec: Spec): Route[] {
  const routes: Route[] = [];
  for (const [template, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op === null || typeof op !== 'object' || op.operationId === undefined) continue;
      const names: string[] = [];
      const source = template
        .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
        .replace(/\{(\w+)\}/g, (_m, n) => {
          names.push(n as string);
          return '([^/]+)';
        });
      const requiresIfMatch = (op.parameters ?? []).some(
        (p) => (p as { $ref?: string }).$ref === '#/components/parameters/IfMatch',
      );
      routes.push({
        method: method.toUpperCase(),
        template,
        operationId: op.operationId,
        pattern: new RegExp(`^${source}$`),
        names,
        requiresIfMatch,
        operator: JSON.stringify(op.security ?? []).includes('operatorCredential'),
      });
    }
  }
  return routes;
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, detail, code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

export interface AdminMock {
  fetch: typeof fetch;
  /** Requests whose method and path are not an operation of the published contract. */
  unpublished: string[];
  /** `METHOD template` of every request that matched an operation, in order. */
  matched: string[];
  /** The `Authorization` headers seen. */
  credentials: string[];
  /** The `DEP-Actor` headers seen. */
  actors: string[];
}

export function createAdminMock(): AdminMock {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  const routes = routesOf(spec);
  const unpublished: string[] = [];
  const matched: string[] = [];
  const credentials: string[] = [];
  const actors: string[] = [];

  let quotas: Json = {};
  let quotaVersion = 1;
  const origins: string[] = ['https://app.example.test'];
  const keys: Json[] = [
    {
      kid: 'host-1',
      use: 'user',
      alg: 'ES256',
      thumbprint: 'tp-host-1',
      issuer: null,
      jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    },
  ];
  let retention: Json = { mode: 'keep_all' };
  let retentionVersion = 0;
  const docRetention = new Map<string, { policy: Json; version: number }>();
  const holds: Json[] = [];
  const hooks = new Map<string, { row: Json; version: number; secrets: number }>();
  const tenants = new Map<string, { row: Json; version: number }>([
    [
      '0190a000-0000-7000-8000-0000000000a1',
      {
        row: {
          id: '0190a000-0000-7000-8000-0000000000a1',
          name: 'Example tenant',
          state: 'active',
          createdAt: '2026-11-01T09:00:00.000Z',
        },
        version: 1,
      },
    ],
  ]);
  const tenantFonts = new Map<string, Json>();
  const audit: Json[] = [];
  let counter = 0;
  const id = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, '0')}`;
  const note = (actor: string, kind: string, document: string | null = null): void => {
    audit.unshift({
      id: id('ev'),
      document,
      actor,
      kind,
      scopes: ['tenant'],
      at: new Date(Date.UTC(2026, 10, 18, 9, 0, audit.length)).toISOString(),
    });
  };

  const ok = (body: unknown, status = 200, etag?: string): Response => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (etag !== undefined) headers['ETag'] = etag;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  };
  const policyOf = (b: Json): Json | null => {
    if (b['mode'] === 'keep_all' && b['afterDays'] === undefined) return { mode: 'keep_all' };
    if (
      b['mode'] === 'thin_payloads' &&
      Number.isInteger(b['afterDays']) &&
      (b['afterDays'] as number) >= 1
    )
      return { mode: 'thin_payloads', afterDays: b['afterDays'] };
    return null;
  };
  const view = (doc: string): Json => {
    const own = docRetention.get(doc);
    return own
      ? { policy: own.policy, effective: own.policy, source: 'document' }
      : { policy: null, effective: retention, source: retentionVersion > 0 ? 'tenant' : 'default' };
  };

  function handle(
    route: Route,
    p: Record<string, string>,
    url: URL,
    body: Json,
    actor: string,
    ifMatch: string | null,
  ): Response {
    switch (route.operationId) {
      case 'getTenantQuotas':
        return ok(quotaView(), 200, `"q${quotaVersion}"`);
      case 'setTenantQuotas': {
        for (const [k, v] of Object.entries(body)) {
          if (
            ![
              'connections',
              'openDocuments',
              'commitRate',
              'roomCpuBudget',
              'storage',
              'exportConcurrency',
              'exportMinutes',
            ].includes(k)
          )
            return problem(400, 'validation_failed', `Unknown quota "${k}".`);
          if (!Number.isInteger(v) || (v as number) < 0)
            return problem(400, 'validation_failed', `"${k}" must be a whole number of 0 or more.`);
        }
        if (ifMatch !== `"q${quotaVersion}"`)
          return problem(412, 'conflict', 'The quotas changed.');
        quotas = { ...quotas, ...body };
        quotaVersion += 1;
        note(actor, 'quota.changed');
        return ok(quotaView(), 200, `"q${quotaVersion}"`);
      }
      case 'getTenantOrigins':
        return ok({ origins });
      case 'addTenantOrigin': {
        const o = body['origin'];
        if (typeof o !== 'string' || !/^https?:\/\/[^/]+$/.test(o))
          return problem(
            400,
            'validation_failed',
            'The origin must be scheme, host and port only.',
          );
        if (!origins.includes(o)) {
          origins.push(o);
          note(actor, 'origin.added');
        }
        return ok({ origin: o }, 201);
      }
      case 'removeTenantOrigin': {
        const i = origins.indexOf(p['origin'] ?? '');
        if (i < 0) return problem(404, 'not_found', 'No such origin.');
        origins.splice(i, 1);
        note(actor, 'origin.removed');
        return ok(null, 204);
      }
      case 'getTenantKeys':
        return ok({ keys });
      case 'registerTenantKey': {
        if (
          typeof body['kid'] !== 'string' ||
          typeof body['jwk'] !== 'object' ||
          body['jwk'] === null
        )
          return problem(400, 'validation_failed', 'A key needs a kid and a jwk.');
        if ('d' in (body['jwk'] as Json) || (body['jwk'] as Json)['kty'] === 'oct')
          return problem(400, 'validation_failed', 'Only public asymmetric keys are accepted.');
        if (keys.some((k) => k['kid'] === body['kid']))
          return problem(409, 'conflict', 'That kid is registered.');
        const k = { issuer: null, ...body, thumbprint: `tp-${String(body['kid'])}` };
        keys.push(k);
        note(actor, 'key.registered');
        return ok(k, 201);
      }
      case 'removeTenantKey': {
        const i = keys.findIndex((k) => k['kid'] === p['kid']);
        if (i < 0) return problem(404, 'not_found', 'No such key.');
        keys.splice(i, 1);
        note(actor, 'key.removed');
        return ok(null, 204);
      }
      case 'getTenantRetention':
        return ok(retention, 200, `"r${retentionVersion}"`);
      case 'setTenantRetention': {
        const next = policyOf(body);
        if (next === null) return problem(400, 'validation_failed', 'Not a retention policy.');
        if (ifMatch !== `"r${retentionVersion}"`) return problem(412, 'conflict', 'It changed.');
        retention = next;
        retentionVersion += 1;
        note(actor, 'retention.changed');
        return ok(retention, 200, `"r${retentionVersion}"`);
      }
      case 'getDocumentRetention':
        return ok(view(p['id'] ?? ''), 200, `"d${docRetention.get(p['id'] ?? '')?.version ?? 0}"`);
      case 'setDocumentRetention': {
        const next = policyOf(body);
        if (next === null) return problem(400, 'validation_failed', 'Not a retention policy.');
        const doc = p['id'] ?? '';
        const version = (docRetention.get(doc)?.version ?? 0) + 1;
        if (ifMatch !== `"d${version - 1}"`) return problem(412, 'conflict', 'It changed.');
        docRetention.set(doc, { policy: next, version });
        note(actor, 'retention.changed', doc);
        return ok(view(doc), 200, `"d${version}"`);
      }
      case 'listHolds':
        return ok({ items: holds, nextCursor: null });
      case 'placeHold': {
        const reason = body['reason'];
        if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500)
          return problem(400, 'validation_failed', 'A reason of 1 to 500 characters is needed.');
        const h = {
          id: id('hold'),
          document: p['id'],
          reason: reason.trim(),
          placedBy: actor,
          placedAt: '2026-11-18T09:00:00.000Z',
        };
        holds.push(h);
        note(actor, 'hold.placed', p['id'] ?? null);
        return ok(h, 201);
      }
      case 'releaseHold': {
        const at = holds.findIndex((h) => h['id'] === p['holdId'] && h['document'] === p['id']);
        if (at < 0) return problem(404, 'not_found', 'No such hold in force.');
        const [gone] = holds.splice(at, 1);
        note(actor, 'hold.released', p['id'] ?? null);
        return ok(gone);
      }
      case 'getTenantUsage': {
        const month = url.searchParams.get('month') ?? '2026-11';
        if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month))
          return problem(400, 'validation_failed', 'The month is YYYY-MM.');
        return ok({
          month,
          connections: 12,
          openDocuments: 7,
          commitRate: 31,
          roomCpuBudget: 480,
          storage: 1_048_576,
          exportConcurrency: 2,
          exportMinutes: 45,
        });
      }
      case 'listTenants':
        return ok({ items: [...tenants.values()].map((t) => t.row), nextCursor: null });
      case 'createTenant': {
        const name = body['name'];
        if (typeof name !== 'string' || name.trim() === '')
          return problem(400, 'validation_failed', 'A name is needed.');
        const row = {
          id: `0190a000-0000-7000-8000-${String(++counter).padStart(12, '0')}`,
          name: name.trim(),
          state: 'active',
          createdAt: '2026-11-18T09:00:00.000Z',
        };
        tenants.set(row.id, { row, version: 1 });
        note(actor, 'tenant.created');
        return ok(row, 201);
      }
      case 'getTenant': {
        const t = tenants.get(p['tenantId'] ?? '');
        if (!t) return problem(404, 'not_found', 'No such tenant.');
        return ok(t.row, 200, `"t${t.version}"`);
      }
      case 'updateTenant': {
        const t = tenants.get(p['tenantId'] ?? '');
        if (!t) return problem(404, 'not_found', 'No such tenant.');
        if (ifMatch !== `"t${t.version}"`) return problem(412, 'conflict', 'The tenant changed.');
        if (
          body['state'] !== undefined &&
          body['state'] !== 'active' &&
          body['state'] !== 'suspended'
        )
          return problem(400, 'validation_failed', 'The state is active or suspended.');
        t.row = { ...t.row, ...body };
        t.version += 1;
        note(actor, 'tenant.updated');
        return ok(t.row, 200, `"t${t.version}"`);
      }
      case 'addTenantFont': {
        if (typeof body['licence'] !== 'string' || body['licence'].trim() === '')
          return problem(400, 'validation_failed', 'A licence declaration is needed.');
        if (typeof body['content'] !== 'string' || body['content'] === '')
          return problem(400, 'validation_failed', 'The font file is needed.');
        const sha256 = [...body['content'].slice(0, 16)]
          .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('')
          .padEnd(64, '0')
          .slice(0, 64);
        const font = {
          sha256,
          family: 'Added Sans',
          style: 'regular',
          format: 'truetype',
          bytes: body['content'].length,
          licence: body['licence'],
          serverUse: body['serverUse'] === true,
        };
        tenantFonts.set(sha256, font);
        note(actor, 'font.added');
        return ok(font, 201);
      }
      case 'removeTenantFont': {
        if (!tenantFonts.delete(p['sha256'] ?? ''))
          return problem(404, 'not_found', 'No such font of this tenant.');
        note(actor, 'font.removed');
        return ok({ removed: p['sha256'] });
      }
      case 'listWebhooks':
        return ok({ items: [...hooks.values()].map((h) => hookView(h)), nextCursor: null });
      case 'createWebhook': {
        if (typeof body['url'] !== 'string' || !/^https:\/\//.test(body['url']))
          return problem(400, 'validation_failed', 'A webhook address must be https.');
        const row = {
          id: id('wh'),
          url: body['url'],
          events: Array.isArray(body['events']) ? body['events'] : [],
          createdAt: '2026-11-18T09:00:00.000Z',
          updatedAt: '2026-11-18T09:00:00.000Z',
        };
        const h = { row, version: 1, secrets: 1 };
        hooks.set(row.id, h);
        note(actor, 'webhook.changed');
        return ok({ ...hookView(h), secret: 'whsec_created' }, 201, `"w1"`);
      }
      case 'getWebhook': {
        const h = hooks.get(p['id'] ?? '');
        return h
          ? ok(hookView(h), 200, `"w${h.version}"`)
          : problem(404, 'not_found', 'No such subscription.');
      }
      case 'updateWebhook': {
        const h = hooks.get(p['id'] ?? '');
        if (!h) return problem(404, 'not_found', 'No such subscription.');
        if (ifMatch !== `"w${h.version}"`) return problem(412, 'conflict', 'It changed.');
        let secret: string | undefined;
        if (body['rotate'] === true) {
          if (h.secrets > 1) return problem(409, 'conflict', 'A rotation is in progress.');
          h.secrets = 2;
          secret = 'whsec_rotated';
        } else if (body['retire'] === true) {
          h.secrets = 1;
        } else {
          if (typeof body['url'] === 'string') h.row['url'] = body['url'];
          if (Array.isArray(body['events'])) h.row['events'] = body['events'];
        }
        h.version += 1;
        note(actor, 'webhook.changed');
        return ok(secret ? { ...hookView(h), secret } : hookView(h), 200, `"w${h.version}"`);
      }
      case 'deleteWebhook':
        if (!hooks.delete(p['id'] ?? '')) return problem(404, 'not_found', 'No such subscription.');
        note(actor, 'webhook.changed');
        return ok(null, 204);
      case 'pingWebhook':
        return hooks.has(p['id'] ?? '')
          ? ok({ deliveryId: id('dl') }, 202)
          : problem(404, 'not_found', 'No such subscription.');
      case 'replayWebhookDelivery':
        return hooks.has(p['id'] ?? '')
          ? ok({ deliveryId: id('dl') }, 202)
          : problem(404, 'not_found', 'No such subscription.');
      case 'getAudit': {
        const q = url.searchParams;
        const items = audit.filter(
          (e) =>
            (!q.get('document') || e['document'] === q.get('document')) &&
            (!q.get('actor') || e['actor'] === q.get('actor')) &&
            (!q.get('kind') || e['kind'] === q.get('kind')),
        );
        return ok({ items, nextCursor: null });
      }
      case 'getFonts':
        return ok({
          version: '1',
          defaultFamily: 'Libre Serif',
          families: [
            {
              family: 'Libre Serif',
              role: 'text',
              licence: 'OFL-1.1',
              lineHeight: 1.2,
              faces: [
                {
                  style: 'regular',
                  weight: 400,
                  italic: false,
                  url: '/fonts/a.ttf',
                  sha256: 'a'.repeat(64),
                  bytes: 1000,
                  format: 'truetype',
                },
              ],
            },
          ],
        });
      default:
        return problem(404, 'not_found', `${route.operationId} is not offered by this mock.`);
    }
  }
  function quotaView(): Json {
    const out: Json = {};
    for (const k of [
      'connections',
      'openDocuments',
      'commitRate',
      'roomCpuBudget',
      'storage',
      'exportConcurrency',
      'exportMinutes',
    ])
      out[k] = quotas[k] ?? null;
    return out;
  }
  function hookView(h: { row: Json; secrets: number }): Json {
    return { ...h.row, activeSecrets: h.secrets };
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.startsWith('/v1') ? url.pathname.slice(3) : url.pathname;
    let route: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      route = r;
      params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]));
      break;
    }
    if (!route) {
      unpublished.push(`${method} ${url.pathname}`);
      return problem(404, 'not_found', 'No such route.');
    }
    matched.push(`${method} ${route.template}`);
    const auth = headers.get('Authorization');
    if (auth !== null) credentials.push(auth);
    actors.push(headers.get('DEP-Actor') ?? '');
    if (auth === null) return problem(401, 'unauthenticated', 'A credential is required.');
    if (auth !== `Bearer ${route.operator ? OPERATOR_CREDENTIAL : SERVICE_CREDENTIAL}`)
      return problem(
        403,
        'forbidden',
        `Only ${route.operator ? 'an operator' : 'a service'} credential may call this route.`,
      );
    if (route.requiresIfMatch && !headers.has('If-Match'))
      return problem(428, 'precondition_failed', 'If-Match is required.');
    let body: Json = {};
    if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body) as Json;
    return handle(
      route,
      params,
      url,
      body,
      headers.get('DEP-Actor') ?? 'system',
      headers.get('If-Match'),
    );
  };

  return { fetch: fetchImpl, unpublished, matched, credentials, actors };
}
