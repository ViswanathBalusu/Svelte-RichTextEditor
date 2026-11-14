/**
 * A JSON Web Signature forger for the adversarial client (SEC-002; 10 §2: "assume a user will send
 * hand-crafted protocol messages"). It is deliberately not the service's own `jwt.ts`: it signs
 * with any key and any algorithm, including `alg: none`, a symmetric algorithm keyed with a public
 * key, and algorithms off the allow-list, and it writes any header member (`jku`, `x5u`, `jwk`,
 * `kid`), so the token-confusion tests (SEC-013) can present what the component never would.
 *
 * Every key here is generated in the test; no real secret is used (packet F brief).
 */
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

export type Alg = 'ES256' | 'EdDSA' | 'RS256' | 'HS256' | 'none' | (string & {});

export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface KeyPair {
  alg: Alg;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The public JWK as the tenant registration stores it. */
  jwk: PublicJwk;
}

export function b64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

/** A fresh key pair of the algorithm; the public JWK is the shape the registry keeps. */
export function keyPair(alg: 'ES256' | 'EdDSA' | 'RS256'): KeyPair {
  const pair =
    alg === 'EdDSA'
      ? generateKeyPairSync('ed25519')
      : alg === 'ES256'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const e = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const jwk: PublicJwk =
    alg === 'EdDSA'
      ? { kty: 'OKP', crv: 'Ed25519', x: e['x']! }
      : alg === 'ES256'
        ? { kty: 'EC', crv: 'P-256', x: e['x']!, y: e['y']! }
        : { kty: 'RSA', n: e['n']!, e: e['e']! };
  return { alg, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk };
}

function rawSign(alg: Alg, key: KeyObject, input: Buffer): Buffer {
  switch (alg) {
    case 'ES256':
      return cryptoSign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
    case 'EdDSA':
      return cryptoSign(null, input, key);
    case 'RS256':
      return cryptoSign('sha256', input, key);
    default:
      throw new Error(`rawSign cannot sign ${alg}`);
  }
}

/**
 * Signs a compact JWS with whatever header and payload are given. `none` writes an empty signature;
 * `HS256` is an HMAC keyed with `hmacKey` (the confusion test passes a public key there, so that a
 * verifier that confused the algorithms would accept it). An asymmetric algorithm uses `key`.
 */
export function signJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  opts: { key?: KeyObject; hmacKey?: string | Buffer } = {},
): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const data = Buffer.from(input, 'ascii');
  const alg = header['alg'] as Alg;
  if (alg === 'none') return `${input}.`;
  if (alg === 'HS256') {
    if (opts.hmacKey === undefined) throw new Error('HS256 needs hmacKey');
    return `${input}.${createHmac('sha256', opts.hmacKey).update(data).digest('base64url')}`;
  }
  // An algorithm off the allow-list is refused at the header before the signature is read, so a
  // placeholder signature is enough to make a well-formed token for that case.
  if (alg !== 'ES256' && alg !== 'EdDSA' && alg !== 'RS256')
    return `${input}.${b64url(`off-allow-list:${alg}`)}`;
  if (!opts.key) throw new Error(`${alg} needs a key`);
  return `${input}.${b64url(rawSign(alg, opts.key, data))}`;
}

/** A public key in PEM, so an HS256 forgery can be keyed with it (the classic confusion). */
export function publicPem(key: KeyObject): string {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  return pub.export({ format: 'pem', type: 'spki' }).toString();
}

export { createPrivateKey, createPublicKey };
