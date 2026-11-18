/**
 * Per-document sealing of objects (HIS-041; 08 §13; 06 §4.2). An `ObjectStore` decorator: an object
 * under `tenants/<tenant>/docs/<doc>/` (the checkpoints, the cold segments and the set-aside
 * checkpoints) of a document that has its own key is sealed with that document's data key
 * (`DocumentKeys`, storage/document-keys.ts). Objects of other documents, and of tenants and
 * documents without a key, pass through unchanged, so a tenant that does not use the option sees
 * no change (criterion 4).
 *
 * Reading unwraps the data key through the key service. If the key was destroyed the read fails
 * with `DocumentKeyDestroyedError`; if the key service cannot be reached it fails with
 * `DocumentKeyUnavailableError`. Neither returns sealed bytes as content. The object key is the
 * additional data, so a sealed object copied under another key does not open.
 *
 * Put this decorator over the raw store and under nothing else of the document's: the tenant seal
 * of `EncryptedObjectStore` (BE-041) may wrap it, which is then a second layer.
 * `signedUrl` returns a URL of the sealed bytes, which a reader cannot open without the key.
 */
import { isSealed, type DocumentKeys, type DocumentSealer } from '../storage/document-keys.ts';
import type { DocRef } from '../storage/types.ts';
import type { ObjectStore, PutOptions } from './store.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DOC_OBJECT = new RegExp(`^tenants/(${UUID})/docs/(${UUID})/`, 'i');

/** The document an object key belongs to, or null for any other key. */
export function documentOfObjectKey(key: string): DocRef | null {
  const m = DOC_OBJECT.exec(key);
  return m ? { tenant: m[1]!.toLowerCase(), doc: m[2]!.toLowerCase() } : null;
}

export class DocumentKeyedObjectStore implements ObjectStore {
  readonly #inner: ObjectStore;
  readonly #keys: DocumentKeys;

  constructor(inner: ObjectStore, keys: DocumentKeys) {
    this.#inner = inner;
    this.#keys = keys;
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const ref = documentOfObjectKey(key);
    const sealer = ref ? await this.#keys.sealerFor(ref) : null;
    await this.#inner.put(key, sealer ? await sealer.seal(key, body) : body, opts);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const stored = await this.#inner.get(key);
    if (stored === null || !isSealed(stored)) return stored;
    const ref = documentOfObjectKey(key);
    const sealer = ref ? await this.#keys.sealerFor(ref) : null;
    if (!sealer) throw new Error(`the sealed object ${key} has no document key to open it`);
    return sealer.open(key, stored);
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
}

/**
 * Seals the objects a document already has (the content it was created with), over the raw store.
 * Used by `DocumentKeys.provision` through its `sealExisting` hook. An object that is already
 * sealed is left as it is.
 */
export async function sealExistingObjects(
  raw: ObjectStore,
  ref: DocRef,
  sealer: DocumentSealer,
): Promise<number> {
  let sealed = 0;
  for (const key of await raw.list(`tenants/${ref.tenant}/docs/${ref.doc}/`)) {
    const bytes = await raw.get(key);
    if (bytes === null || isSealed(bytes)) continue;
    await raw.put(key, await sealer.seal(key, bytes));
    sealed++;
  }
  return sealed;
}
