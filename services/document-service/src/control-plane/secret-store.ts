/**
 * The secret store (BE-057 criterion 6; 10 §3.7 "Secrets are held in a secret manager"; owner
 * decision 70: a port, with an encrypted table as the default adapter, and an operator may plug in
 * a secret manager).
 *
 * `SecretStore` is the port. A subscription's webhook secrets live behind it: the subscription row
 * holds only a reference, `SecretBackedSubscriptionStore` puts each secret in the store when a
 * record is written and reads it back when a record is read, and drops it when the secret is
 * retired or the subscription deleted. So the subscription store never holds a secret, and a log
 * line cannot carry one, because nothing but the signing step ever has the value.
 *
 * Adapters: `MemorySecretStore` here; the encrypted table in `secret-store-pg.ts`. A secret
 * manager is another implementation of the same three methods.
 */
import { uuid7 } from '@docedit/model';
import type { SubscriptionRecord, SubscriptionStore } from './webhook-subscriptions.ts';

export interface SecretStore {
  /** Stores `value` under `ref` for the tenant, replacing an earlier one. */
  put(tenant: string, ref: string, value: string): Promise<void>;
  /** The value, or null when the tenant has none under `ref` (another tenant's is not visible). */
  get(tenant: string, ref: string): Promise<string | null>;
  /** Drops the value; a reference that is not there is not an error. */
  remove(tenant: string, ref: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly #rows = new Map<string, string>();

  put(tenant: string, ref: string, value: string): Promise<void> {
    this.#rows.set(`${tenant}\u0000${ref}`, value);
    return Promise.resolve();
  }

  get(tenant: string, ref: string): Promise<string | null> {
    return Promise.resolve(this.#rows.get(`${tenant}\u0000${ref}`) ?? null);
  }

  remove(tenant: string, ref: string): Promise<void> {
    this.#rows.delete(`${tenant}\u0000${ref}`);
    return Promise.resolve();
  }
}

const REF_PREFIX = 'webhook-secret/';

/**
 * A subscription store whose records carry references in place of secrets. The records it passes
 * on (to `inner`) hold `secrets: [ref, ...]`; the records it returns hold the values.
 */
export class SecretBackedSubscriptionStore implements SubscriptionStore {
  readonly #inner: SubscriptionStore;
  readonly #secrets: SecretStore;
  readonly #newRef: () => string;

  constructor(inner: SubscriptionStore, secrets: SecretStore, newRef: () => string = uuid7) {
    this.#inner = inner;
    this.#secrets = secrets;
    this.#newRef = newRef;
  }

  async #resolve(row: SubscriptionRecord): Promise<SubscriptionRecord> {
    const values: string[] = [];
    for (const ref of row.secrets) {
      const v = await this.#secrets.get(row.tenant, ref);
      if (v === null) throw new Error(`the secret ${ref} of a subscription is not in the store`);
      values.push(v);
    }
    return { ...row, secrets: values };
  }

  /**
   * The references for a record's values: a value already stored under a reference of `before`
   * keeps it, and a new value is put in the store under a new one.
   */
  async #refsFor(record: SubscriptionRecord, before: SubscriptionRecord | null): Promise<string[]> {
    const known = new Map<string, string>();
    if (before)
      for (const ref of before.secrets) {
        const v = await this.#secrets.get(before.tenant, ref);
        if (v !== null) known.set(v, ref);
      }
    const out: string[] = [];
    for (const v of record.secrets) {
      const kept = known.get(v);
      if (kept !== undefined) {
        out.push(kept);
        continue;
      }
      const ref = `${REF_PREFIX}${record.id}/${this.#newRef()}`;
      await this.#secrets.put(record.tenant, ref, v);
      out.push(ref);
    }
    return out;
  }

  async insert(record: SubscriptionRecord): Promise<void> {
    await this.#inner.insert({ ...record, secrets: await this.#refsFor(record, null) });
  }

  async get(tenant: string, id: string): Promise<SubscriptionRecord | null> {
    const row = await this.#inner.get(tenant, id);
    return row ? this.#resolve(row) : null;
  }

  async list(tenant: string): Promise<SubscriptionRecord[]> {
    const out: SubscriptionRecord[] = [];
    for (const row of await this.#inner.list(tenant)) out.push(await this.#resolve(row));
    return out;
  }

  async replace(next: SubscriptionRecord, expectedVersion: number): Promise<boolean> {
    const before = await this.#inner.get(next.tenant, next.id);
    const refs = await this.#refsFor(next, before);
    const ok = await this.#inner.replace({ ...next, secrets: refs }, expectedVersion);
    if (!ok) {
      // The write lost the race: what was put for it is not wanted.
      for (const ref of refs)
        if (!before?.secrets.includes(ref)) await this.#secrets.remove(next.tenant, ref);
      return false;
    }
    // A secret that is retired leaves the store.
    for (const ref of before?.secrets ?? [])
      if (!refs.includes(ref)) await this.#secrets.remove(next.tenant, ref);
    return true;
  }

  async remove(tenant: string, id: string): Promise<boolean> {
    const before = await this.#inner.get(tenant, id);
    const ok = await this.#inner.remove(tenant, id);
    if (ok) for (const ref of before?.secrets ?? []) await this.#secrets.remove(tenant, ref);
    return ok;
  }
}
