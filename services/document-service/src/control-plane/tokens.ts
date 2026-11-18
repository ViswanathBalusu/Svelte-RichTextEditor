/**
 * Tokens and service credentials (05 §3; PRO-009 to PRO-012; BE-033; 10 §3.2).
 *
 * - User tokens are host-signed with a key registered for the tenant, or minted by `POST /tokens`
 *   with the service's own key. Keys are selected by `tid` from the registration, or are the
 *   service's own; nothing in a token names its key by URL (PRO-010).
 * - Service credentials are API keys or JWTs with the type header `dep-svc+jwt`, verified against
 *   the separate service key set. A user token never becomes a service credential: its type header
 *   is not `dep-svc+jwt`, and no user key verifies a service credential (05 §3.2).
 *
 * Every verified user is mapped to their per-tenant surrogate (BE-013), and the revocation
 * watermarks of 05 §3.3 apply here, so both planes refuse revoked tokens.
 */
import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { DOC_ROLES, type Connection, type DocRole, parsePrincipal } from '@docedit/authority';
import { formatTimestamp, parseTimestamp, uuid7 } from '@docedit/model';
import type { TokenRequest } from '@docedit/protocol';
import type { VerifiedIdentity, VerifyToken } from '../seams.ts';
import { isUuid } from '../storage/ids.ts';
import {
  type Algorithm,
  type PublicJwk,
  JwsError,
  decodeJws,
  headerAlgorithm,
  importPrivateJwk,
  importPublicJwk,
  signJws,
  verifySignature,
} from './jwt.ts';
import { ApiError } from './problems.ts';
import { secretMatches, type TenantRegistry } from './tenants.ts';
import type { UserDirectory } from './users.ts';

/** 05 §3.1: `exp` at most 15 minutes after `iat`. */
export const MAX_LIFETIME_S = 15 * 60;
/** 05 §3.1: verifiers allow 60 seconds of clock skew. */
export const SKEW_S = 60;
/** 05 §3.1: at most 20 documents in `docs`. */
export const MAX_DOCS = 20;
/** The type header of a service JWT (05 §3.2). */
export const SERVICE_JWT_TYPE = 'dep-svc+jwt';
/** The prefix of an API key: `dsk_<tenant>_<key id>_<secret>` (ADR 0036). */
export const API_KEY_PREFIX = 'dsk_';

const RESTRICTIONS = ['no-export', 'no-copy', 'no-print'];

/** The key the service signs minted tokens with (05 §3.1 "service-minted"). */
export interface SigningKey {
  kid: string;
  alg: Algorithm;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: PublicJwk;
}

/** A signing key from a private JWK, or a new Ed25519 key that lives as long as the process. */
export function signingKey(jwk?: Record<string, unknown>, kid?: string): SigningKey {
  if (jwk) {
    const k = importPrivateJwk(jwk);
    return {
      kid: kid ?? (typeof jwk['kid'] === 'string' ? jwk['kid'] : 'service-1'),
      alg: k.alg,
      privateKey: k.key,
      publicKey: importPublicJwk(k.publicJwk, k.alg),
      publicJwk: k.publicJwk,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    kid: kid ?? `ephemeral-${randomUUID()}`,
    alg: 'EdDSA',
    privateKey,
    publicKey,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: pub.x },
  };
}

/** Who a verified service credential is (05 §3.2). */
export interface ServiceIdentity {
  tenant: string;
  /** The API key's identifier or the service JWT's key identifier, for logs and audit. */
  credential: string;
}

/**
 * Verification of the credentials a request or a socket carries (`TokenVerifier`, 06 §14; BE-002):
 * user tokens (05 §3.1) and service credentials (05 §3.2). The pipeline and the data plane depend
 * on this, so a deployment may verify with another implementation; minting is not part of it.
 */
export interface TokenVerifier {
  /** The data plane's `VerifyToken` (seams.ts): a user token to the identity it proves. */
  readonly verifyUser: VerifyToken;
  /** An API key or a service JWT to the tenant it belongs to. */
  verifyService(credential: string): Promise<ServiceIdentity>;
}

export interface TokenServiceOptions {
  registry: TenantRegistry;
  users: UserDirectory;
  /** The service identifier: `aud` of every token, `iss` of minted ones (05 §3.1). */
  serviceId: string;
  signing: SigningKey;
  now?: () => number;
  /** Lifetime of a minted token without `expiresIn`, seconds (default 900; test mode, BE-079). */
  defaultLifetimeS?: number;
  /**
   * The name of the claim that lists the role placeholders a user may fill outside a workflow,
   * for a tenant (05 §3.1; 12 §13; owner decision 5a of 2026-11-15). Default `wfr` for every tenant.
   */
  fillRolesClaim?: (tenant: string) => string;
}

/** The default name of the fill roles claim (05 §3.1). */
export const FILL_ROLES_CLAIM = 'wfr';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const refuse = (detail: string): ApiError => new ApiError('unauthenticated', detail);

/** A `sub`, group or principal value: 1 to 255 characters, no whitespace or control characters. */
export function isOpaqueId(v: unknown): v is string {
  return typeof v === 'string' && parsePrincipal(`user:${v}`) !== null;
}

export class TokenService implements TokenVerifier {
  readonly #registry: TenantRegistry;
  readonly #users: UserDirectory;
  readonly serviceId: string;
  readonly #signing: SigningKey;
  readonly #now: () => number;
  readonly #defaultLifetimeS: number;
  readonly #fillRolesClaim: (tenant: string) => string;

  constructor(opts: TokenServiceOptions) {
    this.#fillRolesClaim = opts.fillRolesClaim ?? (() => FILL_ROLES_CLAIM);
    this.#registry = opts.registry;
    this.#users = opts.users;
    this.serviceId = opts.serviceId;
    this.#signing = opts.signing;
    this.#now = opts.now ?? Date.now;
    this.#defaultLifetimeS = Math.min(opts.defaultLifetimeS ?? MAX_LIFETIME_S, MAX_LIFETIME_S);
  }

  /** The public keys of minted tokens, published at `jwks_uri` (decision D60). */
  jwks(): { keys: Array<Record<string, unknown>> } {
    return {
      keys: [
        { ...this.#signing.publicJwk, kid: this.#signing.kid, alg: this.#signing.alg, use: 'sig' },
      ],
    };
  }

  /** The data plane's VerifyToken (seams.ts). */
  readonly verifyUser: VerifyToken = (token) => this.#verifyUser(token);

  async #verifyUser(token: string): Promise<VerifiedIdentity> {
    let jws;
    try {
      jws = decodeJws(token);
    } catch (e) {
      throw refuse(e instanceof JwsError ? e.message : 'the token is malformed');
    }
    const { header, payload } = jws;
    // A service credential is not a user token, whatever its claims say (05 §3.2).
    if (header['typ'] === SERVICE_JWT_TYPE)
      throw refuse('a service credential is not a user token');
    let alg: Algorithm;
    try {
      alg = headerAlgorithm(header);
    } catch (e) {
      throw refuse((e as Error).message);
    }
    const tid = payload['tid'];
    if (!isUuid(tid)) throw refuse('tid must name a registered tenant');
    if (!(await this.#registry.exists(tid))) throw refuse('tid must name a registered tenant');

    // The key: the service's own for the tokens it minted, else one registered for the tenant.
    const own = payload['iss'] === this.serviceId && header['kid'] === this.#signing.kid;
    let verified = false;
    if (own) {
      verified =
        alg === this.#signing.alg &&
        verifySignature(alg, this.#signing.publicKey, jws.signingInput, jws.signature);
    } else {
      const keys = (await this.#registry.keys(tid, 'user')).filter(
        (k) => k.alg === alg && (header['kid'] === undefined || header['kid'] === k.kid),
      );
      for (const k of keys) {
        if (k.issuer !== null && payload['iss'] !== k.issuer) continue;
        if (verifySignature(alg, importPublicJwk(k.jwk, k.alg), jws.signingInput, jws.signature)) {
          verified = true;
          break;
        }
      }
    }
    if (!verified) throw refuse('no key registered for the tenant verifies the token');

    const claims = this.#checkTimes(payload);
    if (typeof payload['iss'] !== 'string' || !payload['iss']) throw refuse('iss is required');
    const sub = payload['sub'];
    if (!isOpaqueId(sub)) throw refuse('sub must be 1 to 255 characters without whitespace');
    const docs = this.#checkDocs(payload['docs']);
    const name = payload['name'];
    if (name !== undefined && typeof name !== 'string') throw refuse('name must be a string');
    const grp = payload['grp'];
    if (grp !== undefined && !(Array.isArray(grp) && grp.every(isOpaqueId)))
      throw refuse('grp must be an array of group identifiers');
    const restrict = restrictOf(payload['restrict']);
    const asserted = assertedOf(payload);
    const accessSince = accessSinceOf(payload['access_since']);
    // Form mode without a workflow: the roles the user may fill come from the tenant's claim, and
    // the participant is active while the document is not locked (12 §13). The host signs them.
    const claimName = this.#fillRolesClaim(tid);
    const fillRoles = fillRolesOf(payload[claimName], claimName);

    const user = await this.#users.resolve(tid, sub, name);
    // 05 §3.3: tokens issued before a watermark are refused; one for a single document drops it.
    if (user.revokedBefore !== null && claims.iat < user.revokedBefore)
      throw new ApiError('revoked', "the user's sessions were revoked after the token was issued");
    const entries = Object.entries(docs).filter(
      ([doc]) => claims.iat >= (user.documentRevocations.get(doc) ?? Number.NEGATIVE_INFINITY),
    );
    if (entries.length === 0)
      throw new ApiError('revoked', "access to the token's documents was revoked");
    const [doc, role] = entries[0]!;
    const identity: VerifiedIdentity = {
      tenant: tid,
      doc,
      connection: {
        sub: user.surrogate,
        session: '',
        role,
        groups: (grp as string[] | undefined) ?? [],
        participantRoles: fillRoles,
        participantActive: fillRoles.length > 0,
      },
      jti: claims.jti,
      expiresAt: claims.exp,
      docs: Object.fromEntries(entries),
      sub,
      ...(name !== undefined ? { name } : {}),
      issuedAt: claims.iat,
      restrict,
      ...(accessSince !== undefined ? { accessSince } : {}),
      ...(asserted !== undefined ? { asserted } : {}),
    };
    return identity;
  }

  /** `iat`, `exp`, `aud` and `jti` (05 §3.1); times in Unix milliseconds. */
  #checkTimes(payload: Record<string, unknown>): { iat: number; exp: number; jti: string } {
    const { iat, exp, aud, jti } = payload;
    if (typeof aud !== 'string' || aud !== this.serviceId)
      throw refuse('aud must equal the service identifier exactly');
    if (typeof iat !== 'number' || !Number.isFinite(iat)) throw refuse('iat is required');
    if (typeof exp !== 'number' || !Number.isFinite(exp)) throw refuse('exp is required');
    if (typeof jti !== 'string' || !jti) throw refuse('jti is required');
    if (exp - iat > MAX_LIFETIME_S) throw refuse('exp is more than 15 minutes after iat');
    if (exp < iat) throw refuse('exp is before iat');
    const now = this.#now() / 1000;
    if (now > exp + SKEW_S) throw new ApiError('token_expired', 'the token has expired');
    if (iat > now + SKEW_S) throw refuse('iat is in the future');
    return { iat: Math.round(iat * 1000), exp: Math.round(exp * 1000), jti };
  }

  #checkDocs(docs: unknown): Record<string, DocRole> {
    if (!isObject(docs)) throw refuse('docs must be an object');
    const entries = Object.entries(docs);
    if (entries.length === 0) throw refuse('docs names no document');
    if (entries.length > MAX_DOCS) throw refuse(`docs names more than ${MAX_DOCS} documents`);
    const out: Record<string, DocRole> = {};
    for (const [doc, role] of entries) {
      if (!isUuid(doc)) throw refuse('docs keys are document identifiers');
      if (!(DOC_ROLES as readonly unknown[]).includes(role))
        throw refuse('docs roles are viewer, commenter, suggester, editor, owner or filler');
      out[doc] = role as DocRole;
    }
    return out;
  }

  /** Verifies a service credential: an API key or a `dep-svc+jwt` (05 §3.2; BE-033). */
  async verifyService(credential: string): Promise<ServiceIdentity> {
    if (credential.startsWith(API_KEY_PREFIX)) return this.#verifyApiKey(credential);
    let jws;
    try {
      jws = decodeJws(credential);
    } catch (e) {
      throw refuse(e instanceof JwsError ? e.message : 'the credential is malformed');
    }
    if (jws.header['typ'] !== SERVICE_JWT_TYPE)
      throw refuse('a service JWT has the type header dep-svc+jwt');
    let alg: Algorithm;
    try {
      alg = headerAlgorithm(jws.header);
    } catch (e) {
      throw refuse((e as Error).message);
    }
    const tid = jws.payload['tid'];
    if (!isUuid(tid) || !(await this.#registry.exists(tid)))
      throw refuse('tid must name a registered tenant');
    // Only keys registered for service credentials; a user-token key never matches (05 §3.2).
    const keys = (await this.#registry.keys(tid, 'service')).filter(
      (k) => k.alg === alg && (jws.header['kid'] === undefined || jws.header['kid'] === k.kid),
    );
    const key = keys.find(
      (k) =>
        (k.issuer === null || jws.payload['iss'] === k.issuer) &&
        verifySignature(alg, importPublicJwk(k.jwk, k.alg), jws.signingInput, jws.signature),
    );
    if (!key) throw refuse('no service key of the tenant verifies the credential');
    this.#checkTimes(jws.payload);
    return { tenant: tid, credential: `jwt:${key.kid}` };
  }

  async #verifyApiKey(credential: string): Promise<ServiceIdentity> {
    const rest = credential.slice(API_KEY_PREFIX.length);
    const a = rest.indexOf('_');
    const b = a < 0 ? -1 : rest.indexOf('_', a + 1);
    if (a < 0 || b < 0) throw refuse('the API key is malformed');
    const tenant = rest.slice(0, a);
    const id = rest.slice(a + 1, b);
    const secret = rest.slice(b + 1);
    if (!isUuid(tenant) || !isUuid(id) || secret.length < 16)
      throw refuse('the API key is malformed');
    const record = await this.#registry.apiKey(tenant, id);
    if (!record || !secretMatches(secret, record.secretHash))
      throw refuse('the API key is not registered');
    if (record.expiresAt !== null && this.#now() >= record.expiresAt)
      throw refuse('the API key has expired');
    return { tenant, credential: `key:${id}` };
  }

  /** `POST /tokens` (decision D60). `request` has been checked against TokenRequest. */
  async mint(tenant: string, request: TokenRequest): Promise<{ token: string; expiresAt: string }> {
    if (!isOpaqueId(request.sub))
      throw new ApiError(
        'validation_failed',
        'sub must be 1 to 255 characters without whitespace',
        {
          violations: [{ path: '/sub', rule: 'an opaque identifier' }],
        },
      );
    const docs = Object.entries(request.docs);
    if (docs.length === 0)
      throw new ApiError('validation_failed', 'docs names no document', {
        violations: [{ path: '/docs', rule: 'at least one document' }],
      });
    for (const g of request.grp ?? [])
      if (!isOpaqueId(g))
        throw new ApiError('validation_failed', 'a group identifier is 1 to 255 characters', {
          violations: [{ path: '/grp', rule: 'opaque identifiers' }],
        });
    const iat = Math.floor(this.#now() / 1000);
    const lifetime = Math.min(request.expiresIn ?? this.#defaultLifetimeS, MAX_LIFETIME_S);
    const exp = iat + lifetime;
    const claims: Record<string, unknown> = {
      iss: this.serviceId,
      aud: this.serviceId,
      iat,
      exp,
      jti: uuid7(),
      tid: tenant,
      sub: request.sub,
      docs: request.docs,
    };
    for (const k of ['name', 'grp', 'wfp', 'amr', 'auth_time', 'access_since', 'restrict'] as const)
      if (request[k] !== undefined) claims[k] = request[k];
    const token = signJws(
      { alg: this.#signing.alg, typ: 'JWT', kid: this.#signing.kid },
      claims,
      this.#signing.privateKey,
    );
    return { token, expiresAt: formatTimestamp(exp * 1000) };
  }
}

/**
 * The role placeholders of the fill roles claim (05 §3.1): an array of identifiers, each used once
 * in token order. An absent claim is no roles; anything else than an array of identifiers refuses
 * the token, as a malformed `grp` does.
 */
function fillRolesOf(v: unknown, claim: string): readonly string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isOpaqueId))
    throw refuse(`${claim} must be an array of role placeholder identifiers`);
  return [...new Set<string>(v)];
}

/**
 * The `restrict` claim (05 §3.1; PRO-015 criterion 2). It must be an array; each value is one of
 * the known restrictions, and any other value is ignored (05 §1 rule 3; PRO-005). Duplicates
 * are dropped, and the order of the token is kept.
 */
function restrictOf(v: unknown): readonly string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw refuse('restrict must be an array of restriction names');
  const known = new Set<string>();
  for (const r of v) if (typeof r === 'string' && RESTRICTIONS.includes(r)) known.add(r);
  return [...known];
}

/**
 * The `wfp`, `amr` and `auth_time` claims (12 §7; PRO-015 criterion 3), kept as given when they
 * have the expected type. Returns undefined when the token carries none of them. The data plane
 * records them per channel when the token is accepted (`data-plane/asserted-claims.ts`).
 */
function assertedOf(payload: Record<string, unknown>):
  | {
      wfp?: string;
      amr?: readonly string[];
      auth_time?: number;
    }
  | undefined {
  const out: { wfp?: string; amr?: readonly string[]; auth_time?: number } = {};
  const wfp = payload['wfp'];
  if (typeof wfp === 'string' && wfp.length > 0) out.wfp = wfp;
  const amr = payload['amr'];
  if (Array.isArray(amr) && amr.every((m) => typeof m === 'string'))
    out.amr = [...(amr as string[])];
  const authTime = payload['auth_time'];
  if (typeof authTime === 'number' && Number.isFinite(authTime)) out.auth_time = authTime;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The `access_since` claim (05 §3.1; 08 §9) in Unix milliseconds: an RFC 3339 timestamp, as
 * `POST /tokens` mints it (D60), or a NumericDate in seconds. Anything else refuses the token.
 */
function accessSinceOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1000);
  if (typeof v === 'string') {
    try {
      return parseTimestamp(v);
    } catch {
      // Refused below.
    }
  }
  throw refuse('access_since is a timestamp');
}

/** The connection of a verified user on one of the token's documents, or null (05 §3.1 `docs`). */
export function connectionFor(
  identity: VerifiedIdentity,
  doc: string,
  session = identity.connection.session,
): Connection | null {
  const role = identity.docs[doc];
  if (role === undefined) return null;
  return { ...identity.connection, role, session };
}

/** A new API key for `tenant`: the credential to hand out once, and what the registry keeps. */
export function newApiKey(tenant: string): { credential: string; id: string; secret: string } {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  return { credential: `${API_KEY_PREFIX}${tenant}_${id}_${secret}`, id, secret };
}
