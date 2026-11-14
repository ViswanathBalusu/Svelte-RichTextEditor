/**
 * The host's token endpoint logic (13 §11.1 item 1; 05 §3.1; UX-092): the host has authenticated
 * its user (here: the demo session), decides their role on the document from its own catalogue,
 * and returns a short-lived token for that one document. Two issuers (05 §3.1):
 *
 * - service-minted: the host's server calls `POST /tokens` with its service credential (PRO-011);
 * - host-signed: the host's server signs the token with its own key, registered for the tenant.
 *
 * The private key and the service credential stay on the server. The token goes to the page in a
 * response body only, never in a URL, a log line or browser storage (UX-092 criterion 3).
 */
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { DocRole, Restriction, TokenRequest } from '@docedit/protocol';
import type { Catalogue, CatalogueEntry } from './catalogue.ts';
import type { HostSigning } from './config.ts';
import { MAX_TOKEN_SECONDS } from './config.ts';
import type { DirectoryUser } from './directory.ts';
import type { ServiceClient } from './service.ts';

export interface IssuedToken {
  token: string;
  /** RFC 3339. */
  expiresAt: string;
}

export interface TokenGrant {
  user: DirectoryUser;
  /** The one document the token is for; `docs` may hold at most 20 (05 §3.1). */
  doc: string;
  role: DocRole;
  /** When the host first gave the user access, for `access_since`. */
  accessSince?: string;
  /** Output restrictions the owner set on the user (05 §3.1 `restrict`); none when empty. */
  restrict?: readonly Restriction[];
}

export interface TokenIssuer {
  readonly mode: 'service-minted' | 'host-signed';
  issue(grant: TokenGrant): Promise<IssuedToken>;
}

/**
 * What the host grants `person` on a document, from its catalogue: the role, when access was first
 * given, and the output restrictions the owner set (UX-095 criterion 5). Null when the document is
 * unknown, deleted or not shared with the person. The token endpoint uses this and nothing else.
 */
export function grantFor(entry: CatalogueEntry | null, person: DirectoryUser): TokenGrant | null {
  const role = entry?.roles[person.sub];
  if (!entry || !role) return null;
  const since = entry.accessSince[person.sub];
  return {
    user: person,
    doc: entry.id,
    role,
    ...(since !== undefined ? { accessSince: since } : {}),
    restrict: entry.restrict?.[person.sub] ?? [],
  };
}

/**
 * The token endpoint's logic (`POST /as/<sub>/api/token`): the grant from the catalogue as it is
 * now, issued by the host's issuer. Null when the person has no role on the document (403).
 */
export async function tokenFor(
  h: { catalogue: Catalogue; tokens: TokenIssuer },
  person: DirectoryUser,
  docId: string,
): Promise<IssuedToken | null> {
  const grant = grantFor(h.catalogue.get(docId), person);
  return grant ? h.tokens.issue(grant) : null;
}

function claimsOf(grant: TokenGrant): Omit<TokenRequest, 'expiresIn'> {
  return {
    sub: grant.user.sub,
    docs: { [grant.doc]: grant.role },
    name: grant.user.name,
    grp: [...grant.user.groups],
    ...(grant.accessSince !== undefined ? { access_since: grant.accessSince } : {}),
    ...(grant.restrict !== undefined && grant.restrict.length > 0
      ? { restrict: [...grant.restrict] }
      : {}),
  };
}

/** Tokens minted by the service (`POST /tokens`); the service sets `iss`, `aud`, `iat`, `exp`, `jti`, `tid`. */
export function serviceMinted(client: ServiceClient, seconds: number): TokenIssuer {
  const expiresIn = Math.min(seconds, MAX_TOKEN_SECONDS);
  return {
    mode: 'service-minted',
    issue: (grant) => client.mintToken({ ...claimsOf(grant), expiresIn }),
  };
}

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString('base64url');

export interface HostSignedOptions {
  signing: HostSigning;
  tenant: string;
  /** The service identifier; `aud` must equal it exactly (05 §3.1). */
  serviceId: string;
  seconds: number;
  now?: () => number;
}

/** Tokens the host signs itself with ES256, an algorithm of the allow-list (05 §3.1; PRO-010). */
export function hostSigned(opts: HostSignedOptions): TokenIssuer {
  const key: KeyObject = createPrivateKey({ key: opts.signing.privateJwk, format: 'jwk' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('the host signing key must be a P-256 key for ES256');
  const now = opts.now ?? Date.now;
  const seconds = Math.min(opts.seconds, MAX_TOKEN_SECONDS);
  return {
    mode: 'host-signed',
    async issue(grant) {
      const iat = Math.floor(now() / 1000);
      const exp = iat + seconds;
      const header = { alg: 'ES256', typ: 'JWT', kid: opts.signing.kid };
      const payload = {
        iss: opts.signing.issuer,
        aud: opts.serviceId,
        iat,
        exp,
        jti: randomUUID(),
        tid: opts.tenant,
        ...claimsOf(grant),
      };
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      // JWS (RFC 7518 §3.4) wants the raw r || s form, not DER.
      const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
      return {
        token: `${input}.${b64url(signature)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
  };
}
