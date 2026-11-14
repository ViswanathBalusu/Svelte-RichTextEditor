/**
 * `KeyService` (06 §14; ADR 0013; BE-002 criterion 5). The service signs and unwraps with keys it
 * holds. Its operations return signatures, unwrapped data keys and public halves of keys, and no
 * operation returns private key material. Workers hold no keys of their own (ADR 0013).
 *
 * Two purposes exist: `sign` keys are ECDSA P-256 (ES256, as user tokens use), and `unwrap` keys
 * are RSA-OAEP 2048 with SHA-256, so that a caller can wrap a data key with the public half and only
 * the service can unwrap it. `MemoryKeyService` is the in-process implementation over WebCrypto.
 * A PostgreSQL or KMS-backed implementation would satisfy the same interface.
 */
import { webcrypto } from 'node:crypto';

type CryptoKeyPair = webcrypto.CryptoKeyPair;
/** A JSON Web Key as WebCrypto names it. */
export type Jwk = webcrypto.JsonWebKey;
const { subtle } = webcrypto;

export type KeyPurpose = 'sign' | 'unwrap';

export interface KeyService {
  /** Creates a key pair for `keyId`. Refused when the identifier already exists. */
  create(keyId: string, purpose: KeyPurpose): Promise<void>;
  /** The public half of a key as a JWK. It never carries private members (`d`, `p`, `q`, ...). */
  publicJwk(keyId: string): Promise<Jwk>;
  /** An ES256 signature over `data` by a `sign` key (IEEE P1363 form, 64 bytes). */
  sign(keyId: string, data: Uint8Array): Promise<Uint8Array>;
  /** Unwraps a data key that was wrapped with the public half of an `unwrap` key. */
  unwrap(keyId: string, wrapped: Uint8Array): Promise<Uint8Array>;
  /** Whether a key exists and is not disabled. Writers check it before they wrap a data key. */
  enabled(keyId: string): Promise<boolean>;
  /** Stops the key from signing or unwrapping. Other keys are unaffected. */
  disable(keyId: string): Promise<void>;
}

export class KeyNotFoundError extends Error {
  override name = 'KeyNotFoundError';
}

export class KeyExistsError extends Error {
  override name = 'KeyExistsError';
}

export class KeyDisabledError extends Error {
  override name = 'KeyDisabledError';
}

/** The key does not have the purpose the operation needs. */
export class KeyPurposeError extends Error {
  override name = 'KeyPurposeError';
}

interface StoredKey {
  readonly purpose: KeyPurpose;
  readonly pair: CryptoKeyPair;
  readonly publicJwk: Jwk;
  enabled: boolean;
}

/** Wraps a data key with a public JWK of an `unwrap` key. The caller needs no key service for this. */
export async function wrapDataKey(publicJwk: Jwk, dataKey: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  return new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, key, dataKey));
}

/** In-process `KeyService`. Keys live in this object and nowhere else. */
export class MemoryKeyService implements KeyService {
  readonly #keys = new Map<string, StoredKey>();

  async create(keyId: string, purpose: KeyPurpose): Promise<void> {
    assertKeyId(keyId);
    if (this.#keys.has(keyId)) throw new KeyExistsError(`key ${keyId} exists`);
    const pair =
      purpose === 'sign'
        ? await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        : await subtle.generateKey(
            {
              name: 'RSA-OAEP',
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: 'SHA-256',
            },
            true,
            ['encrypt', 'decrypt'],
          );
    const publicJwk = await subtle.exportKey('jwk', pair.publicKey);
    this.#keys.set(keyId, { purpose, pair, publicJwk: stripPublic(publicJwk), enabled: true });
  }

  async publicJwk(keyId: string): Promise<Jwk> {
    const key = this.#lookup(keyId);
    return { ...key.publicJwk };
  }

  async sign(keyId: string, data: Uint8Array): Promise<Uint8Array> {
    const key = this.#usable(keyId, 'sign');
    const signature = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key.pair.privateKey,
      data,
    );
    return new Uint8Array(signature);
  }

  async unwrap(keyId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    const key = this.#usable(keyId, 'unwrap');
    const plain = await subtle.decrypt({ name: 'RSA-OAEP' }, key.pair.privateKey, wrapped);
    return new Uint8Array(plain);
  }

  async enabled(keyId: string): Promise<boolean> {
    return this.#keys.get(keyId)?.enabled ?? false;
  }

  async disable(keyId: string): Promise<void> {
    this.#lookup(keyId).enabled = false;
  }

  #lookup(keyId: string): StoredKey {
    const key = this.#keys.get(keyId);
    if (!key) throw new KeyNotFoundError(`key ${keyId} is unknown`);
    return key;
  }

  #usable(keyId: string, purpose: KeyPurpose): StoredKey {
    const key = this.#lookup(keyId);
    if (key.purpose !== purpose) throw new KeyPurposeError(`key ${keyId} is not a ${purpose} key`);
    if (!key.enabled) throw new KeyDisabledError(`key ${keyId} is disabled`);
    return key;
  }
}

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

function stripPublic(jwk: Jwk): Jwk {
  const out: Jwk = { ...jwk };
  for (const member of PRIVATE_MEMBERS) Reflect.deleteProperty(out, member);
  return out;
}

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function assertKeyId(keyId: string): void {
  if (!KEY_ID.test(keyId)) throw new Error('key identifier is malformed');
}
