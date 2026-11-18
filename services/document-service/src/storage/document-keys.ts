/**
 * Per-document encryption keys (HIS-041; 08 §13 third bullet; 06 §12; 10 §3.7; owner decision 43).
 *
 * A sensitive document can have a key of its own, so that destroying the key makes every copy of
 * its content unreadable, backups included. The design is envelope encryption in two levels:
 *
 * - the key encryption key (KEK) is an `unwrap` key of `KeyService`, named `document-<doc>`; its
 *   private half never leaves the key service, and `KeyService.destroy` removes it for good;
 * - the data key (DEK) is one AES-256-GCM key per document. It is stored only wrapped with the KEK
 *   (`document_keys.wrapped_dek`, migration 0075). A reader unwraps it through the key service, so
 *   a key service outage makes the document unavailable and never makes it readable without the
 *   key (criterion 3).
 *
 * What is sealed with the DEK: the payload of each commit and the content of each snapshot commit
 * in PostgreSQL (`PgLogStore`), and every object under the document's prefix in object storage, the
 * checkpoints and cold segments among them (`DocumentKeyedObjectStore`). What stays in the clear:
 * the commit metadata rows, the payload hashes and the hash chain (the chain covers the hash of the
 * plain payload, so it still verifies after the key is gone, criterion 2).
 *
 * Not covered, and said so in the story: the title and properties of the document, the search
 * index, the outbox, comments, assets and export files. A document that needs those gone is purged
 * (HIS-039), which the key destruction does not replace.
 *
 * A document gets its key while its log is empty (head seq 0), so that no commit is ever written
 * in the clear. The content it was created with, an object at seq 0, is sealed at that moment.
 * A tenant has the option off by default (`tenant_document_keys`); with it off the service gives no
 * key, and nothing else about the tenant's documents changes (criterion 4).
 *
 * Envelope of a sealed value: the four bytes `DKS1`, a 12-byte IV, then the AES-GCM ciphertext with
 * its 16-byte tag. The additional data names the place (`<doc>/<seq>` for a payload, `snapshot/…`
 * for a snapshot, the object key for an object), so a sealed value copied elsewhere does not open.
 */
import { randomBytes, webcrypto } from 'node:crypto';
import {
  KeyDestroyedError,
  KeyNotFoundError,
  wrapDataKey,
  type KeyService,
} from './key-service.ts';
import type { DocRef } from './types.ts';

const { subtle } = webcrypto;
const MAGIC = new Uint8Array([0x44, 0x4b, 0x53, 0x31]); // "DKS1"
const IV_BYTES = 12;

/** The KEK of a document in `KeyService`. */
export function documentKeyId(doc: string): string {
  return `document-${doc.toLowerCase()}`;
}

/** The document's key is gone: it was destroyed, so the content cannot be read any more. */
export class DocumentKeyDestroyedError extends Error {
  override name = 'DocumentKeyDestroyedError';
  readonly doc: string;
  constructor(doc: string) {
    super(`the key of document ${doc} was destroyed, so its content is unreadable`);
    this.doc = doc;
  }
}

/** The document's key cannot be had now (the key service failed or refuses); nothing is read. */
export class DocumentKeyUnavailableError extends Error {
  override name = 'DocumentKeyUnavailableError';
  readonly doc: string;
  constructor(doc: string, cause: unknown) {
    super(`the key of document ${doc} is not available now`, { cause });
    this.doc = doc;
  }
}

/** A request the key rules refuse (the option is off, the document has a key, or has history). */
export class DocumentKeyRefusedError extends Error {
  override name = 'DocumentKeyRefusedError';
  readonly reason: 'option-off' | 'has-key' | 'has-history' | 'no-key';
  constructor(reason: DocumentKeyRefusedError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface DocumentKeyRow {
  readonly keyId: string;
  /** The DEK wrapped with the KEK; null once the key was destroyed. */
  readonly wrappedDek: Uint8Array | null;
  readonly state: 'active' | 'destroyed';
  readonly createdAt: number;
  readonly destroyedAt: number | null;
}

/** The rows of the keys. `PgDocumentKeyStore` is the PostgreSQL implementation. */
export interface DocumentKeyStore {
  /** Whether the tenant has the option on. Off when no row says otherwise. */
  tenantEnabled(tenant: string): Promise<boolean>;
  setTenantEnabled(tenant: string, enabled: boolean): Promise<void>;
  get(ref: DocRef): Promise<DocumentKeyRow | null>;
  /** Stores a new key row. Returns false when the document already has one. */
  insert(ref: DocRef, row: DocumentKeyRow): Promise<boolean>;
  /** Marks the key destroyed and drops the wrapped DEK. */
  markDestroyed(ref: DocRef, at: number): Promise<void>;
}

export class MemoryDocumentKeyStore implements DocumentKeyStore {
  readonly #options = new Map<string, boolean>();
  readonly #rows = new Map<string, DocumentKeyRow>();

  async tenantEnabled(tenant: string): Promise<boolean> {
    return this.#options.get(tenant) ?? false;
  }
  async setTenantEnabled(tenant: string, enabled: boolean): Promise<void> {
    this.#options.set(tenant, enabled);
  }
  async get(ref: DocRef): Promise<DocumentKeyRow | null> {
    return this.#rows.get(`${ref.tenant}/${ref.doc}`) ?? null;
  }
  async insert(ref: DocRef, row: DocumentKeyRow): Promise<boolean> {
    const k = `${ref.tenant}/${ref.doc}`;
    if (this.#rows.has(k)) return false;
    this.#rows.set(k, row);
    return true;
  }
  async markDestroyed(ref: DocRef, at: number): Promise<void> {
    const k = `${ref.tenant}/${ref.doc}`;
    const row = this.#rows.get(k);
    if (row) this.#rows.set(k, { ...row, wrappedDek: null, state: 'destroyed', destroyedAt: at });
  }
}

/** Seals and opens values with one document's DEK. Made by `DocumentKeys.sealerFor`. */
export class DocumentSealer {
  readonly #dek: webcrypto.CryptoKey;

  constructor(dek: webcrypto.CryptoKey) {
    this.#dek = dek;
  }

  async seal(aad: string, plain: Uint8Array): Promise<Uint8Array> {
    const iv = randomBytes(IV_BYTES);
    const ciphertext = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
        this.#dek,
        plain,
      ),
    );
    const out = new Uint8Array(MAGIC.length + IV_BYTES + ciphertext.byteLength);
    out.set(MAGIC, 0);
    out.set(iv, MAGIC.length);
    out.set(ciphertext, MAGIC.length + IV_BYTES);
    return out;
  }

  /** Opens a sealed value. A value that is not sealed is returned as it is (history before the key). */
  async open(aad: string, stored: Uint8Array): Promise<Uint8Array> {
    if (!isSealed(stored)) return stored;
    const iv = stored.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const ciphertext = stored.subarray(MAGIC.length + IV_BYTES);
    try {
      return new Uint8Array(
        await subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
          this.#dek,
          ciphertext,
        ),
      );
    } catch {
      throw new Error('a sealed value does not open with the key of its document');
    }
  }
}

/** Whether a stored value is sealed by a document key. */
export function isSealed(stored: Uint8Array): boolean {
  if (stored.byteLength < MAGIC.length + IV_BYTES) return false;
  for (let i = 0; i < MAGIC.length; i++) if (stored[i] !== MAGIC[i]) return false;
  return true;
}

export interface DocumentKeysDeps {
  store: DocumentKeyStore;
  keys: KeyService;
  /** The head sequence number of the document's log. A key is given only while it is 0. */
  headSeq: (ref: DocRef) => Promise<number>;
  /**
   * Reseals what already exists for the document once its key is made: the objects under its prefix
   * (the content it was created with). Absent: nothing is resealed.
   */
  sealExisting?: (ref: DocRef, sealer: DocumentSealer) => Promise<void>;
  now: () => number;
}

export class DocumentKeys {
  readonly #d: DocumentKeysDeps;

  constructor(deps: DocumentKeysDeps) {
    this.#d = deps;
  }

  /** Turns the option on or off for a tenant. Off stops new keys; existing keys keep working. */
  setTenantOption(tenant: string, enabled: boolean): Promise<void> {
    return this.#d.store.setTenantEnabled(tenant, enabled);
  }

  /** Whether the tenant has the option on. */
  tenantOption(tenant: string): Promise<boolean> {
    return this.#d.store.tenantEnabled(tenant);
  }

  /** Gives the document a key of its own (criterion 1). Refused with `DocumentKeyRefusedError`. */
  async provision(ref: DocRef): Promise<void> {
    if (!(await this.#d.store.tenantEnabled(ref.tenant)))
      throw new DocumentKeyRefusedError(
        'option-off',
        'this tenant does not have per-document keys',
      );
    if ((await this.#d.store.get(ref)) !== null)
      throw new DocumentKeyRefusedError('has-key', `document ${ref.doc} has a key`);
    if ((await this.#d.headSeq(ref)) !== 0)
      throw new DocumentKeyRefusedError(
        'has-history',
        'a key is given while the log is empty; commits already written stay in the clear',
      );
    const keyId = documentKeyId(ref.doc);
    await this.#d.keys.create(keyId, 'unwrap');
    try {
      const dek = randomBytes(32);
      const wrapped = await wrapDataKey(await this.#d.keys.publicJwk(keyId), dek);
      const inserted = await this.#d.store.insert(ref, {
        keyId,
        wrappedDek: wrapped,
        state: 'active',
        createdAt: this.#d.now(),
        destroyedAt: null,
      });
      if (!inserted) throw new DocumentKeyRefusedError('has-key', `document ${ref.doc} has a key`);
      if (this.#d.sealExisting) {
        const sealer = await this.sealerFor(ref);
        if (sealer) await this.#d.sealExisting(ref, sealer);
      }
    } catch (e) {
      // The key is made but unused: it is destroyed so that no half-made key lingers.
      await this.#d.keys.destroy(keyId).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Destroys the document's key (criterion 2). The KEK goes first, so from that moment nothing can
   * unwrap the DEK; the row then records it and drops the wrapped DEK. Idempotent.
   */
  async destroy(ref: DocRef): Promise<void> {
    const row = await this.#d.store.get(ref);
    if (!row) throw new DocumentKeyRefusedError('no-key', `document ${ref.doc} has no key`);
    await this.#d.keys.destroy(row.keyId);
    if (row.state !== 'destroyed') await this.#d.store.markDestroyed(ref, this.#d.now());
  }

  /** Whether the document has a key (active or destroyed). */
  async has(ref: DocRef): Promise<boolean> {
    return (await this.#d.store.get(ref)) !== null;
  }

  /**
   * The sealer for the document, or null when it has no key (nothing is sealed). The DEK is
   * unwrapped through the key service on each call, which is why an outage reaches the reader
   * (criterion 3): a destroyed key throws `DocumentKeyDestroyedError`, any other failure
   * `DocumentKeyUnavailableError`.
   */
  async sealerFor(ref: DocRef): Promise<DocumentSealer | null> {
    let row: DocumentKeyRow | null;
    try {
      row = await this.#d.store.get(ref);
    } catch (e) {
      throw new DocumentKeyUnavailableError(ref.doc, e);
    }
    if (row === null) return null;
    if (row.state === 'destroyed' || row.wrappedDek === null)
      throw new DocumentKeyDestroyedError(ref.doc);
    try {
      const raw = await this.#d.keys.unwrap(row.keyId, row.wrappedDek);
      const dek = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
      return new DocumentSealer(dek);
    } catch (e) {
      if (e instanceof KeyDestroyedError || e instanceof KeyNotFoundError)
        throw new DocumentKeyDestroyedError(ref.doc);
      throw new DocumentKeyUnavailableError(ref.doc, e);
    }
  }
}
