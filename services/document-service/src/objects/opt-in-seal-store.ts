/**
 * Tenant sealing for the tenants that opt in (BE-041; owner decision 274 of
 * docs/owner-decisions-2026-11-26.md: "Only tenants who opt in have their files sealed with their
 * own key"; docs/adr/0105-storage-backlog-batch.md, open question 3).
 *
 * An `ObjectStore` decorator over `EncryptedObjectStore`. An object of an opted-in tenant that only
 * the service reads, the objects under `tenants/<tenant>/docs/<doc>/` (checkpoints, cold segments,
 * set-aside checkpoints), is sealed with that tenant's key from `KeyService`. Every other object,
 * and every object of a tenant that has not opted in, passes through unchanged.
 *
 * Why the prefixes are limited: some objects are read by someone other than the service. A client
 * writes `quarantine/` through a pre-signed URL, the asset origin reads `assets/` from the bucket
 * and holds no keys (ADR 0013), and exports and final PDFs are downloaded through signed URLs. A
 * seal over them would hand those readers sealed bytes. Whether the asset origin and the downloads
 * go through the service is not decided (docs/adr/0436-w5-BE-041-opt-in-tenant-seal.md, proposed).
 *
 * Objects written before a tenant opted in are plain, and reading one of them as a sealed object
 * fails with `SealError`. Sealing the existing objects is not built.
 */
import { EncryptedObjectStore } from './encrypted-store.ts';
import type { KeyService } from '../storage/key-service.ts';
import type { ObjectStore, PutOptions } from './store.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SEALED_KEY = new RegExp(`^tenants/(${UUID})/docs/`, 'i');

/** The tenant whose seal covers this object key, or null when the key is not one the seal covers. */
export function sealedPrefixTenant(key: string): string | null {
  const match = SEALED_KEY.exec(key);
  return match?.[1] ? match[1].toLowerCase() : null;
}

export class OptInTenantSealStore implements ObjectStore {
  readonly #inner: ObjectStore;
  readonly #sealed: EncryptedObjectStore;
  readonly #tenants: ReadonlySet<string>;

  constructor(inner: ObjectStore, keys: KeyService, tenants: Iterable<string>) {
    this.#inner = inner;
    this.#sealed = new EncryptedObjectStore(inner, keys);
    this.#tenants = new Set([...tenants].map((tenant) => tenant.toLowerCase()));
  }

  /** The tenants that opted in. */
  get tenants(): readonly string[] {
    return [...this.#tenants];
  }

  /** Creates the key of every opted-in tenant that has none yet. Call it once at start-up. */
  async provision(): Promise<void> {
    for (const tenant of this.#tenants) await this.#sealed.provision(tenant);
  }

  #covers(key: string): boolean {
    const tenant = sealedPrefixTenant(key);
    return tenant !== null && this.#tenants.has(tenant);
  }

  put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    return (this.#covers(key) ? this.#sealed : this.#inner).put(key, body, opts);
  }

  get(key: string): Promise<Uint8Array | null> {
    return (this.#covers(key) ? this.#sealed : this.#inner).get(key);
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
