/**
 * Verification of the tokens a server mints against the keys it publishes at `jwks_uri` (05 §3.1;
 * D60), with WebCrypto only: the kit checks the signature as a host would, without the server's code.
 */
import { webcrypto } from 'node:crypto';
import { isObject } from './assert.ts';

const subtle = webcrypto.subtle;

/** The algorithms 05 §3.1 allows. */
export const ALLOWED_ALGS = ['ES256', 'EdDSA', 'RS256'] as const;

type Jwk = Record<string, unknown>;

function importParams(alg: string): {
  key: Parameters<typeof subtle.importKey>[2];
  verify: Parameters<typeof subtle.verify>[0];
} | null {
  if (alg === 'ES256')
    return {
      key: { name: 'ECDSA', namedCurve: 'P-256' },
      verify: { name: 'ECDSA', hash: 'SHA-256' },
    };
  if (alg === 'EdDSA') return { key: { name: 'Ed25519' }, verify: { name: 'Ed25519' } };
  if (alg === 'RS256')
    return {
      key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      verify: { name: 'RSASSA-PKCS1-v1_5' },
    };
  return null;
}

/** Only the members WebCrypto needs, so that `use`, `key_ops` or `alg` cannot get in the way. */
function publicPart(jwk: Jwk): webcrypto.JsonWebKey {
  const out: Record<string, unknown> = {};
  for (const k of ['kty', 'crv', 'x', 'y', 'n', 'e'])
    if (typeof jwk[k] === 'string') out[k] = jwk[k];
  return out as webcrypto.JsonWebKey;
}

export interface Verification {
  ok: boolean;
  reason: string;
}

/** Verifies a compact JWS against a JWK Set. */
export async function verifyJws(token: string, jwks: unknown): Promise<Verification> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a compact JWS' };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, reason: 'the header is not JSON' };
  }
  const alg = typeof header['alg'] === 'string' ? header['alg'] : '';
  const params = importParams(alg);
  if (!params) return { ok: false, reason: `algorithm ${alg} is not on the allow-list (05 §3.1)` };
  if (!isObject(jwks) || !Array.isArray(jwks['keys']))
    return { ok: false, reason: 'the JWK Set has no keys' };
  const keys = (jwks['keys'] as unknown[]).filter(isObject);
  const kid = header['kid'];
  const candidates = typeof kid === 'string' ? keys.filter((k) => k['kid'] === kid) : keys;
  if (!candidates.length)
    return { ok: false, reason: `no key with kid ${String(kid)} in the JWK Set` };
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2]!, 'base64url');
  for (const k of candidates) {
    try {
      const key = await subtle.importKey('jwk', publicPart(k), params.key, false, ['verify']);
      if (await subtle.verify(params.verify, key, sig, data))
        return { ok: true, reason: `verified with ${alg}` };
    } catch {
      // try the next key
    }
  }
  return { ok: false, reason: 'the signature does not verify with any published key' };
}
