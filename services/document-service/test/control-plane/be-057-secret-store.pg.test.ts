// The encrypted table of the secret store on PostgreSQL (BE-057 criterion 6; owner decision 70;
// migration 0101). The value is not in the table; a row moved to another tenant, another reference
// or opened under another key does not open; a tenant sees only its own rows. Skips when PostgreSQL
// is not up.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EncryptedTableSecretStore } from '../../src/control-plane/secret-store-pg.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const why = await postgresUnavailable();

describe.skipIf(why)('EncryptedTableSecretStore (BE-057 criterion 6)', () => {
  let db: TestDatabase;
  const key = { id: 'k1', key: randomBytes(32) };
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('round-trips a value, keeps it out of the table, and replaces and removes it', async () => {
    const store = new EncryptedTableSecretStore(db.service, key);
    const t = randomUUID();
    await store.put(t, 'webhook-secret/a', 'whsec_plain-value');
    expect(await store.get(t, 'webhook-secret/a')).toBe('whsec_plain-value');
    const raw = await db.admin.query('select * from secret_store where tenant_id = $1', [t]);
    expect(raw.rowCount).toBe(1);
    expect(JSON.stringify(raw.rows)).not.toContain('plain-value');
    expect(Buffer.from(raw.rows[0].ciphertext).includes(Buffer.from('plain-value'))).toBe(false);
    await store.put(t, 'webhook-secret/a', 'whsec_second');
    expect(await store.get(t, 'webhook-secret/a')).toBe('whsec_second');
    await store.remove(t, 'webhook-secret/a');
    expect(await store.get(t, 'webhook-secret/a')).toBeNull();
    await store.remove(t, 'webhook-secret/a');
  });

  it('does not show a tenant another tenant row, and does not open a moved row', async () => {
    const store = new EncryptedTableSecretStore(db.service, key);
    const [t1, t2] = [randomUUID(), randomUUID()];
    await store.put(t1, 'ref', 'whsec_t1');
    expect(await store.get(t2, 'ref')).toBeNull();
    // A row copied to another tenant (by the operator's login, which bypasses the policy) does not
    // open: the tenant is part of what the seal binds.
    await db.admin.query(
      `insert into secret_store (tenant_id, ref, key_id, nonce, ciphertext)
       select $2, ref, key_id, nonce, ciphertext from secret_store where tenant_id = $1`,
      [t1, t2],
    );
    await expect(store.get(t2, 'ref')).rejects.toThrow();
    await db.admin.query('update secret_store set ref = $3 where tenant_id = $1 and ref = $2', [
      t1,
      'ref',
      'other-ref',
    ]);
    await expect(store.get(t1, 'other-ref')).rejects.toThrow();
  });

  it('opens rows sealed under an earlier key, and refuses a row under an unknown one', async () => {
    const old = { id: 'k0', key: randomBytes(32) };
    const t = randomUUID();
    await new EncryptedTableSecretStore(db.service, old).put(t, 'r', 'whsec_old');
    const rotated = new EncryptedTableSecretStore(db.service, key, [old]);
    expect(await rotated.get(t, 'r')).toBe('whsec_old');
    await rotated.put(t, 'r', 'whsec_old');
    const sealed = await db.admin.query('select key_id from secret_store where tenant_id = $1', [
      t,
    ]);
    expect(sealed.rows[0].key_id).toBe('k1');
    await new EncryptedTableSecretStore(db.service, old).put(t, 'r2', 'whsec_x');
    await expect(new EncryptedTableSecretStore(db.service, key).get(t, 'r2')).rejects.toThrow(
      /unknown key/,
    );
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(
      () => new EncryptedTableSecretStore(db.service, { id: 'short', key: randomBytes(16) }),
    ).toThrow(RangeError);
  });
});
