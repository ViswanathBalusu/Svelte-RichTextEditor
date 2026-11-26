/**
 * The encrypted table, the default adapter of the secret store (BE-057 criterion 6; owner decision
 * 70; migration 0101). A value is sealed with AES-256-GCM under a 32-byte key the operator supplies
 * (not stored in the database), with a fresh 12-byte nonce for each write. The tenant, the
 * reference and the key identifier are the additional authenticated data, so a row copied to
 * another tenant or reference, or opened under another key, fails to open. Every query runs under
 * the tenant's row-level security (BE-011).
 *
 * Rotating the key: a new `keyId` and key seal new values; `keys` lists the earlier ones, so rows
 * written under them still open and are sealed again when they are next written.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inTenant, type Pool } from '../storage/db.ts';
import type { SecretStore } from './secret-store.ts';

export const SECRET_STORE_TABLE = 'secret_store';

export interface SecretKey {
  readonly id: string;
  /** 32 bytes. */
  readonly key: Uint8Array;
}

const aad = (tenant: string, ref: string, keyId: string): Buffer =>
  Buffer.from(`${tenant}\n${ref}\n${keyId}`, 'utf8');

export class EncryptedTableSecretStore implements SecretStore {
  readonly #pool: Pool;
  readonly #current: SecretKey;
  readonly #keys: ReadonlyMap<string, Uint8Array>;

  constructor(pool: Pool, current: SecretKey, earlier: readonly SecretKey[] = []) {
    for (const k of [current, ...earlier])
      if (k.key.length !== 32) throw new RangeError(`key ${k.id} is not 32 bytes`);
    this.#pool = pool;
    this.#current = current;
    this.#keys = new Map([current, ...earlier].map((k) => [k.id, k.key]));
  }

  put(tenant: string, ref: string, value: string): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#current.key, nonce);
    cipher.setAAD(aad(tenant, ref, this.#current.id));
    const sealed = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `insert into ${SECRET_STORE_TABLE} (tenant_id, ref, key_id, nonce, ciphertext)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, ref) do update
           set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext`,
        [tenant, ref, this.#current.id, nonce, sealed],
      );
    });
  }

  async get(tenant: string, ref: string): Promise<string | null> {
    const row = await inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ key_id: string; nonce: Buffer; ciphertext: Buffer }>(
          `select key_id, nonce, ciphertext from ${SECRET_STORE_TABLE}
            where tenant_id = $1 and ref = $2`,
          [tenant, ref],
        );
        return r.rows[0] ?? null;
      },
      { readOnly: true },
    );
    if (row === null) return null;
    const key = this.#keys.get(row.key_id);
    if (key === undefined) throw new Error(`the secret ${ref} was sealed under an unknown key`);
    const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
    decipher.setAAD(aad(tenant, ref, row.key_id));
    const body = row.ciphertext.subarray(0, row.ciphertext.length - 16);
    decipher.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  remove(tenant: string, ref: string): Promise<void> {
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(`delete from ${SECRET_STORE_TABLE} where tenant_id = $1 and ref = $2`, [
        tenant,
        ref,
      ]);
    });
  }
}
