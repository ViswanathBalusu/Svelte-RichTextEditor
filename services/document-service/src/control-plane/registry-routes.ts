/**
 * The routes `GET|POST /origins`, `DELETE /origins/{origin}`, `GET|POST /keys` and
 * `DELETE /keys/{kid}` (operations getTenantOrigins, addTenantOrigin, removeTenantOrigin,
 * getTenantKeys, registerTenantKey and removeTenantKey; 05 sections 3.2 and 4; 13 section 10;
 * UX-077). They list and change what the tenant registered: its allowed origins and its public keys.
 *
 * The caller's tenant is the one the pipeline verified, so a listing never holds another tenant's
 * entries and a write never reaches another tenant's registry. A user token is refused with
 * `forbidden` before this handler runs (the operations are service-only). Private key material is
 * never registered: a JWK with a private member is refused, so a listing carries public keys only.
 *
 * Each change that alters the registry is audited after it is stored (UX-077 criterion 5; kinds
 * `key.registered`, `key.removed`, `origin.added` and `origin.removed`, proposed in
 * docs/adr/0372-w3-UX-077-key-origin-writes.md). Registering what is already there changes nothing
 * and is not audited. A record holds identifiers, never the members of a key. The actor is the
 * caller's: the user named by `Dep-Actor`, or `system` (pipeline.ts).
 *
 * A key or an origin has no entity tag, so `If-Match` on a delete is accepted only as `*`.
 */
import { uuid7 } from '@docedit/model';
import { ifMatchTags } from './http.ts';
import { json, type Kit } from './kit.ts';
import type { Ctx, Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';
import {
  KeyRegistrationError,
  normaliseOrigin,
  type KeyUse,
  type TenantKey,
  type TenantRegistry,
} from './tenants.ts';

function keyView(k: TenantKey): Record<string, unknown> {
  return {
    kid: k.kid,
    use: k.use,
    alg: k.alg,
    thumbprint: k.thumbprint,
    issuer: k.issuer,
    jwk: k.jwk,
  };
}

/** JWK members that hold private or symmetric key material (RFC 7518 sections 6.2.2, 6.3.2, 6.4). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

const fail = (message: string): never => {
  throw new ApiError('validation_failed', message);
};

function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return fail(`${what} is an object`);
  return raw as Record<string, unknown>;
}

/** Reads the body of `POST /keys`; a malformed body is `validation_failed`. */
function keyBody(raw: unknown): {
  kid: string;
  use: KeyUse;
  alg: 'ES256' | 'EdDSA' | 'RS256';
  jwk: Record<string, unknown>;
  issuer?: string;
} {
  const b = objectOf(raw, 'the key registration');
  const { kid, use, alg, jwk, issuer } = b;
  if (typeof kid !== 'string' || kid === '') fail('kid is a non-empty string');
  if (use !== 'user' && use !== 'service') fail('use is "user" or "service"');
  if (alg !== 'ES256' && alg !== 'EdDSA' && alg !== 'RS256')
    fail('alg is ES256, EdDSA or RS256; no other algorithm is accepted');
  const key = objectOf(jwk, 'jwk');
  const present = PRIVATE_MEMBERS.filter((m) => m in key);
  if (present.length > 0)
    fail(`jwk holds private or symmetric members (${present.join(', ')}); register the public key`);
  if (issuer !== undefined && issuer !== null && typeof issuer !== 'string')
    fail('issuer is a string or null');
  return {
    kid: kid as string,
    use: use as KeyUse,
    alg: alg as 'ES256' | 'EdDSA' | 'RS256',
    jwk: key,
    ...(typeof issuer === 'string' ? { issuer } : {}),
  };
}

export function registryRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;

  const registry = (): TenantRegistry => {
    if (!d.tenantRegistry) throw new ApiError('not_found', 'this server keeps no tenant registry');
    return d.tenantRegistry;
  };

  const audit = async (ctx: Ctx, kind: string, data: Record<string, unknown>): Promise<void> => {
    await d.audit?.record([
      {
        id: uuid7(),
        tenant: ctx.caller.tenant,
        doc: null,
        actor: ctx.caller.actor,
        kind,
        data,
        at: d.now(),
      },
    ]);
  };

  /** A key or an origin has no entity tag: only `If-Match: *` is accepted on a delete. */
  const starOnly = (ctx: Ctx): void => {
    const tags = ifMatchTags(ctx.req);
    if (tags !== null && tags !== '*')
      throw new ApiError('precondition_failed', 'this resource has no entity tag; use If-Match: *');
  };

  const getTenantOrigins: Handler = async (ctx) => {
    const origins = [...(await registry().origins(ctx.caller.tenant))].sort();
    return json(200, { origins }, { 'Cache-Control': 'no-store' });
  };

  const getTenantKeys: Handler = async (ctx) => {
    const r = registry();
    const user = await r.keys(ctx.caller.tenant, 'user');
    const service = await r.keys(ctx.caller.tenant, 'service');
    return json(200, { keys: [...user, ...service].map(keyView) }, { 'Cache-Control': 'no-store' });
  };

  const registerTenantKey: Handler = async (ctx) => {
    const r = registry();
    const body = keyBody(await ctx.body());
    const tenant = ctx.caller.tenant;
    const before = [...(await r.keys(tenant, 'user')), ...(await r.keys(tenant, 'service'))].find(
      (x) => x.kid === body.kid,
    );
    let key: TenantKey;
    try {
      key = await r.addKey(tenant, body);
    } catch (e) {
      if (!(e instanceof KeyRegistrationError)) throw e;
      // A key already registered under another identifier or for the other use is a conflict;
      // anything else is a malformed key.
      if (/already registered|is registered for/.test(e.message))
        throw new ApiError('conflict', e.message);
      throw new ApiError('validation_failed', e.message);
    }
    if (!before || before.thumbprint !== key.thumbprint || before.issuer !== key.issuer)
      await audit(ctx, 'key.registered', {
        kid: key.kid,
        use: key.use,
        alg: key.alg,
        thumbprint: key.thumbprint,
        replaced: before !== undefined,
      });
    return json(201, keyView(key), { 'Cache-Control': 'no-store' });
  };

  const removeTenantKey: Handler = async (ctx) => {
    const r = registry();
    starOnly(ctx);
    const kid = ctx.params['kid']!;
    const tenant = ctx.caller.tenant;
    const before = [...(await r.keys(tenant, 'user')), ...(await r.keys(tenant, 'service'))].find(
      (x) => x.kid === kid,
    );
    if (!before || !(await r.removeKey(tenant, kid)))
      throw new ApiError('not_found', `no key ${kid}`);
    await audit(ctx, 'key.removed', {
      kid,
      use: before.use,
      alg: before.alg,
      thumbprint: before.thumbprint,
    });
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
  };

  const addTenantOrigin: Handler = async (ctx) => {
    const r = registry();
    const b = objectOf(await ctx.body(), 'the origin registration');
    if (typeof b['origin'] !== 'string' || b['origin'] === '') fail('origin is a non-empty string');
    const origin = normaliseOrigin(b['origin'] as string);
    if (!origin) fail('an origin is a scheme, a host and an optional port');
    const had = (await r.origins(ctx.caller.tenant)).includes(origin as string);
    await r.addOrigin(ctx.caller.tenant, origin as string);
    if (!had) await audit(ctx, 'origin.added', { origin });
    return json(201, { origin }, { 'Cache-Control': 'no-store' });
  };

  const removeTenantOrigin: Handler = async (ctx) => {
    const r = registry();
    starOnly(ctx);
    const origin = normaliseOrigin(ctx.params['origin']!);
    if (!origin || !(await r.removeOrigin(ctx.caller.tenant, origin)))
      throw new ApiError('not_found', 'that origin is not registered');
    await audit(ctx, 'origin.removed', { origin });
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
  };

  return {
    getTenantOrigins,
    getTenantKeys,
    registerTenantKey,
    removeTenantKey,
    addTenantOrigin,
    removeTenantOrigin,
  };
}
