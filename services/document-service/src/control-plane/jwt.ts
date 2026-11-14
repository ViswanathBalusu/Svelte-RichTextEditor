/**
 * JSON Web Signatures in compact form, with node:crypto only (05 §3.1, §3.2; PRO-010; 10 §3.2).
 *
 * Only the asymmetric algorithms of the allow-list are known: ES256, EdDSA and RS256. A key is
 * registered with one algorithm and verifies only that algorithm, so a token cannot choose how it is
 * checked. Header members that name or carry a key (`jku`, `x5u`, `jwk`, `x5c`) are never read: the
 * caller picks the key from the tenant's registration. A header with `crit` is refused, since no
 * extension is understood.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export const ALGORITHMS = ['ES256', 'EdDSA', 'RS256'] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

export function isAlgorithm(v: unknown): v is Algorithm {
  return typeof v === 'string' && (ALGORITHMS as readonly string[]).includes(v);
}

/** A public JWK as registered: only the members that define the key. */
export type PublicJwk =
  | { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  | { kty: 'OKP'; crv: 'Ed25519' | 'Ed448'; x: string }
  | { kty: 'RSA'; n: string; e: string };

export class JwsError extends Error {
  override name = 'JwsError';
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function b64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

function fromB64url(part: string, what: string): Buffer {
  if (!B64URL.test(part)) throw new JwsError(`${what} is not base64url`);
  return Buffer.from(part, 'base64url');
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface DecodedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

/** Splits and parses a compact JWS without checking its signature. */
export function decodeJws(token: string): DecodedJws {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwsError('a JWS has three parts');
  const [h, p, s] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(fromB64url(h, 'the header').toString('utf8'));
    payload = JSON.parse(fromB64url(p, 'the payload').toString('utf8'));
  } catch (e) {
    if (e instanceof JwsError) throw e;
    // The parser's message would quote the input; say only what failed.
    throw new JwsError('the header or the payload is not JSON');
  }
  if (!isObject(header)) throw new JwsError('the header is not an object');
  if (!isObject(payload)) throw new JwsError('the payload is not an object');
  return {
    header,
    payload,
    signingInput: Buffer.from(`${h}.${p}`, 'ascii'),
    signature: fromB64url(s, 'the signature'),
  };
}

/** The algorithm of the header, if it is on the allow-list; `none`, HMAC and the rest are refused. */
export function headerAlgorithm(header: Record<string, unknown>): Algorithm {
  if ('crit' in header) throw new JwsError('critical header extensions are not supported');
  const alg = header['alg'];
  if (!isAlgorithm(alg))
    throw new JwsError('the algorithm is not one of ES256, EdDSA and RS256 (05 §3.1)');
  return alg;
}

/** Checks that `jwk` is a public key of the kind `alg` needs and returns its key object. */
export function importPublicJwk(jwk: unknown, alg: Algorithm): KeyObject {
  if (!isObject(jwk)) throw new JwsError('a key is a JSON object');
  if ('d' in jwk || 'p' in jwk || 'q' in jwk) throw new JwsError('a registered key is public');
  const kind = keyKind(jwk);
  if (kind !== alg) throw new JwsError(`the key is not an ${alg} key`);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: canonicalJwk(jwk) as never, format: 'jwk' });
  } catch {
    throw new JwsError('the key cannot be imported');
  }
  if (alg === 'RS256') {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    // RFC 7518 §3.3: a key of 2048 bits or larger MUST be used with RS256.
    if (bits < 2048) throw new JwsError('an RS256 key has at least 2048 bits (RFC 7518 §3.3)');
  }
  return key;
}

function keyKind(jwk: Record<string, unknown>): Algorithm | null {
  if (jwk['kty'] === 'EC' && jwk['crv'] === 'P-256') return 'ES256';
  if (jwk['kty'] === 'OKP' && (jwk['crv'] === 'Ed25519' || jwk['crv'] === 'Ed448')) return 'EdDSA';
  if (jwk['kty'] === 'RSA') return 'RS256';
  return null;
}

/** The members that define the key (RFC 7638 §3.2), and nothing else. */
export function canonicalJwk(jwk: Record<string, unknown>): PublicJwk {
  const s = (k: string): string => {
    const v = jwk[k];
    if (typeof v !== 'string' || !v || !B64URL.test(v)) throw new JwsError(`the key has no ${k}`);
    return v;
  };
  if (jwk['kty'] === 'EC') return { kty: 'EC', crv: 'P-256', x: s('x'), y: s('y') };
  if (jwk['kty'] === 'OKP')
    return { kty: 'OKP', crv: jwk['crv'] === 'Ed448' ? 'Ed448' : 'Ed25519', x: s('x') };
  if (jwk['kty'] === 'RSA') return { kty: 'RSA', n: s('n'), e: s('e') };
  throw new JwsError('unknown key type');
}

/** The JWK thumbprint (RFC 7638) with SHA-256, base64url. */
export function thumbprint(jwk: PublicJwk): string {
  const ordered =
    jwk.kty === 'EC'
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : jwk.kty === 'OKP'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
        : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return createHash('sha256').update(JSON.stringify(ordered)).digest('base64url');
}

/** Whether `signature` over `input` is valid for `key` under `alg`. Never throws. */
export function verifySignature(
  alg: Algorithm,
  key: KeyObject,
  input: Buffer,
  signature: Buffer,
): boolean {
  try {
    switch (alg) {
      case 'ES256':
        if (key.asymmetricKeyType !== 'ec' || signature.length !== 64) return false;
        return cryptoVerify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'EdDSA':
        if (key.asymmetricKeyType !== 'ed25519' && key.asymmetricKeyType !== 'ed448') return false;
        return cryptoVerify(null, input, key, signature);
      case 'RS256':
        if (key.asymmetricKeyType !== 'rsa') return false;
        return cryptoVerify('sha256', input, key, signature);
    }
  } catch {
    return false;
  }
}

/** Signs a compact JWS. */
export function signJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string {
  const alg = header['alg'];
  if (!isAlgorithm(alg)) throw new JwsError('the algorithm is not one of ES256, EdDSA and RS256');
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const data = Buffer.from(input, 'ascii');
  const sig =
    alg === 'ES256'
      ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
      : alg === 'EdDSA'
        ? cryptoSign(null, data, key)
        : cryptoSign('sha256', data, key);
  return `${input}.${b64url(sig)}`;
}

/** A private signing key from a JWK (with `d`); its algorithm follows from the key type. */
export function importPrivateJwk(jwk: Record<string, unknown>): {
  key: KeyObject;
  alg: Algorithm;
  publicJwk: PublicJwk;
} {
  const alg = keyKind(jwk);
  if (!alg) throw new JwsError('unknown key type');
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: jwk as never, format: 'jwk' });
  } catch {
    throw new JwsError('the private key cannot be imported');
  }
  const publicJwk = canonicalJwk(createPublicKey(key).export({ format: 'jwk' }) as never);
  return { key, alg, publicJwk };
}
