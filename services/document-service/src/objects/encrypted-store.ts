/**
 * Per-tenant envelope encryption of objects (BE-041; 06 §4.2, §12; 10 §3.7). An `ObjectStore`
 * decorator: each object is sealed with a fresh AES-256-GCM data key, and that data key is wrapped
 * with the public half of the tenant's `unwrap` key in `KeyService` (ADR 0013). Reading unwraps it
 * through the key service, so disabling a tenant's key makes that tenant's objects unreadable and
 * leaves other tenants unaffected.
 *
 * The object key is bound into the cipher as associated data, so a sealed object copied to another
 * key does not open. The decorator does not decide which keys a caller may name: `TenantObjects`
 * still does that, and this adapter only refuses keys with no tenant prefix.
 *
 * Envelope layout (version 1): `0x01` | wrapped length (uint16, big endian) | wrapped data key |
 * 12-byte IV | AES-GCM ciphertext with its 16-byte tag.
 *
 * Not decided here (SEC-062 owns it): per-document keys, tenant-owned sealing keys, and rotation.
 * `signedUrl` returns a URL of the sealed bytes, which a reader cannot open without the key.
 */
import { webcrypto } from 'node:crypto';
import {
  KeyExistsError,
  KeyNotFoundError,
  wrapDataKey,
  type KeyService,
} from '../storage/key-service.ts';
import type { ObjectStore, PutOptions } from './store.ts';

const { subtle } = webcrypto;
const VERSION = 1;
const IV_BYTES = 12;
const TENANT_KEY = /^tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

/** The tenant's key identifier in `KeyService`. */
export function tenantKeyId(tenant: string): string {
  return `tenant-${tenant}`;
}

/** The tenant of an object key, read from the key layout of 06 §4.2. */
export function tenantOf(key: string): string {
  const match = TENANT_KEY.exec(key);
  if (!match?.[1]) throw new Error('object key has no tenant prefix');
  return match[1].toLowerCase();
}

/** A sealed object could not be opened: its envelope or its tag is wrong for this key. */
export class SealError extends Error {
  override name = 'SealError';
}

export class EncryptedObjectStore implements ObjectStore {
  readonly #inner: ObjectStore;
  readonly #keys: KeyService;

  constructor(inner: ObjectStore, keys: KeyService) {
    this.#inner = inner;
    this.#keys = keys;
  }

  /**
   * Creates the tenant's `unwrap` key if it does not exist yet. Idempotent and safe to race: a
   * concurrent creation is accepted. A disabled key is left disabled.
   */
  async provision(tenant: string): Promise<void> {
    const keyId = tenantKeyId(tenant.toLowerCase());
    try {
      await this.#keys.publicJwk(keyId);
    } catch (error) {
      if (!(error instanceof KeyNotFoundError)) throw error;
      try {
        await this.#keys.create(keyId, 'unwrap');
      } catch (created) {
        if (!(created instanceof KeyExistsError)) throw created;
      }
    }
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const keyId = tenantKeyId(tenantOf(key));
    if (!(await this.#keys.enabled(keyId))) throw new KeyDisabledWrite(keyId);
    const sealed = await this.#seal(keyId, key, body);
    await this.#inner.put(key, sealed, opts);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const sealed = await this.#inner.get(key);
    if (sealed === null) return null;
    return this.#open(tenantKeyId(tenantOf(key)), key, sealed);
  }

  exists(key: string): Promise<boolean> {
    return this.#inner.exists(key);
  }

  delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }

  signedUrl(key: string, expiresAt: number): string {
    return this.#inner.signedUrl(key, expiresAt);
  }

  async #seal(keyId: string, key: string, body: Uint8Array): Promise<Uint8Array> {
    const publicJwk = await this.#keys.publicJwk(keyId);
    const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const raw = new Uint8Array(await subtle.exportKey('raw', dek));
    const wrapped = await wrapDataKey(publicJwk, raw);
    const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
    const aad = new TextEncoder().encode(key);
    const ciphertext = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, body),
    );
    const out = new Uint8Array(1 + 2 + wrapped.byteLength + IV_BYTES + ciphertext.byteLength);
    const view = new DataView(out.buffer);
    out[0] = VERSION;
    view.setUint16(1, wrapped.byteLength);
    out.set(wrapped, 3);
    out.set(iv, 3 + wrapped.byteLength);
    out.set(ciphertext, 3 + wrapped.byteLength + IV_BYTES);
    return out;
  }

  async #open(keyId: string, key: string, sealed: Uint8Array): Promise<Uint8Array> {
    if (sealed.byteLength < 3 + IV_BYTES || sealed[0] !== VERSION)
      throw new SealError('unknown envelope');
    const wrappedLength = new DataView(
      sealed.buffer,
      sealed.byteOffset,
      sealed.byteLength,
    ).getUint16(1);
    const start = 3 + wrappedLength;
    if (sealed.byteLength < start + IV_BYTES) throw new SealError('truncated envelope');
    const wrapped = sealed.subarray(3, start);
    const iv = sealed.subarray(start, start + IV_BYTES);
    const ciphertext = sealed.subarray(start + IV_BYTES);
    // Unwrapping goes through the key service: a disabled key refuses here (BE-041 criterion 2).
    const raw = await this.#keys.unwrap(keyId, wrapped);
    const dek = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    try {
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
        dek,
        ciphertext,
      );
      return new Uint8Array(plain);
    } catch {
      throw new SealError('object does not open with its key');
    }
  }
}

/** A write under a tenant whose key is disabled or missing; nothing is sent. */
export class KeyDisabledWrite extends Error {
  override name = 'KeyDisabledWrite';
  constructor(keyId: string) {
    super(`key ${keyId} is disabled or missing`);
  }
}
