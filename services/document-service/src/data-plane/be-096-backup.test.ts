/**
 * BE-096 criteria 1 and 2 at the module level (no PostgreSQL, no object store service): the sealing
 * of a backup under a backup key of its own, the refusal of any other key or a changed file, and the
 * audit event for each write, read and copy, per tenant, with no content in it. The PostgreSQL and
 * S3-compatible run is in test/data-plane/be-096-backup.pg.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../objects/store.ts';
import { tenantKeyId } from '../objects/encrypted-store.ts';
import { MemoryAudit } from './memory-ports.ts';
import {
  BackupError,
  backupKey,
  copyBackup,
  openBackup,
  readBackup,
  sealBackup,
  writeBackup,
  type BackupBundle,
} from './backup.ts';

const CANARY = 'CANARY u-be-085-098 document text, never in a backup header or audit line';
const DUMP = 'CREATE TABLE doc_commits (seq integer);\n-- dumped\n';

function keyOf(seedByte: number) {
  return backupKey(Buffer.alloc(32, seedByte).toString('base64'));
}

describe('backup keys (BE-096 criterion 1)', () => {
  it('reads a 32-byte key and gives it an identifier of its own, apart from a tenant key', () => {
    const k = keyOf(7);
    expect(k.id).toMatch(/^backup-[0-9a-f]{16}$/);
    expect(k.id).not.toBe(tenantKeyId(randomUUID()));
    expect(backupKey(Buffer.alloc(32, 7).toString('base64')).id).toBe(k.id);
  });

  it('refuses a key of another length', () => {
    expect(() => backupKey(Buffer.alloc(16).toString('base64'))).toThrow(BackupError);
  });
});

describe('sealing (BE-096 criterion 1)', () => {
  it('round-trips a bundle and holds none of its plain text', () => {
    const kek = keyOf(1);
    const plain = Buffer.from(JSON.stringify({ text: CANARY, sql: DUMP }));
    const sealed = sealBackup(plain, kek);
    expect(sealed.includes(Buffer.from(CANARY))).toBe(false);
    expect(sealed.includes(Buffer.from('CREATE TABLE'))).toBe(false);
    expect(openBackup(sealed, kek).equals(plain)).toBe(true);
  });

  it('refuses a backup sealed with another backup key', () => {
    const sealed = sealBackup(Buffer.from('x'), keyOf(1));
    expect(() => openBackup(sealed, keyOf(2))).toThrow(/another backup key/);
  });

  it('refuses a file whose body was changed', () => {
    const kek = keyOf(3);
    const sealed = Buffer.from(sealBackup(Buffer.from('bundle'), kek));
    sealed[sealed.length - 1]! ^= 0x01;
    expect(() => openBackup(sealed, kek)).toThrow(/damaged/);
  });

  it('refuses a file whose header was changed', () => {
    const kek = keyOf(4);
    const sealed = Buffer.from(sealBackup(Buffer.from('bundle'), kek));
    // The header is JSON after the magic and the length; changing a byte breaks its authentication.
    const headerStart = 5 + 4;
    sealed[headerStart + 20]! ^= 0x01;
    expect(() => openBackup(sealed, kek)).toThrow(BackupError);
  });

  it('refuses a file that is not a backup', () => {
    expect(() => openBackup(Buffer.from('plain text file'), keyOf(5))).toThrow(/not a backup/);
  });

  it('seals each file with fresh keys, so two backups of the same bundle differ', () => {
    const kek = keyOf(6);
    const a = sealBackup(Buffer.from('same'), kek);
    const b = sealBackup(Buffer.from('same'), kek);
    expect(a.equals(b)).toBe(false);
  });
});

describe('the write, read and copy of a backup (BE-096 criterion 2)', () => {
  it('records one event per tenant for each write, read and copy, with identifiers and counts only', async () => {
    const kek = keyOf(9);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const live = new MemoryObjectStore();
    await live.put(`tenants/${tenantA}/checkpoints/0.json`, Buffer.from(CANARY));
    await live.put(`tenants/${tenantB}/checkpoints/0.json`, Buffer.from('other'));
    const target = new MemoryObjectStore();
    const audit = new MemoryAudit();
    const actor = 'operator:u-be-085-098';

    const receipt = await writeBackup({
      source: { dumpDatabase: async () => new TextEncoder().encode(DUMP), objects: live },
      tenants: [tenantA, tenantB],
      kek,
      target,
      targetKey: 'backups/u-be-085-098-1.debk',
      audit: { audit, actor },
    });
    expect(receipt.objects).toBe(2);
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);

    const bundle: BackupBundle = await readBackup({
      target,
      key: receipt.key,
      kek,
      audit: { audit, actor },
    });
    expect(bundle.tenants).toEqual([tenantA, tenantB]);
    expect(Buffer.from(bundle.database, 'base64').toString('utf8')).toBe(DUMP);
    expect(Buffer.from(bundle.objects[0]!.data, 'base64').toString('utf8')).toBe(CANARY);

    await copyBackup({
      target,
      from: receipt.key,
      to: 'backups/u-be-085-098-copy.debk',
      kek,
      audit: { audit, actor },
    });

    for (const tenant of [tenantA, tenantB]) {
      const kinds = (await audit.query(tenant, { limit: 100 })).map((e) => e.kind);
      expect(kinds).toEqual(['backup.written', 'backup.read', 'backup.copied']);
    }
    const events = await audit.query(tenantA, { limit: 100 });
    for (const e of events) {
      expect(e.actor).toBe(actor);
      expect(e.doc).toBeNull();
      expect(JSON.stringify(e)).not.toContain(CANARY);
      expect(JSON.stringify(e)).not.toContain('CREATE TABLE');
    }
  });

  it('refuses to overwrite an existing backup key', async () => {
    const kek = keyOf(10);
    const target = new MemoryObjectStore();
    const audit = new MemoryAudit();
    const args = {
      source: { dumpDatabase: async () => new Uint8Array(), objects: new MemoryObjectStore() },
      tenants: [randomUUID()],
      kek,
      target,
      targetKey: 'backups/once.debk',
      audit: { audit, actor: 'operator' },
    };
    await writeBackup(args);
    await expect(writeBackup(args)).rejects.toThrow(/exists/);
    expect(audit.events.filter((e) => e.kind === 'backup.written')).toHaveLength(1);
  });

  it('a backup sealed with one key is not read with another, and nothing is recorded for it', async () => {
    const target = new MemoryObjectStore();
    const audit = new MemoryAudit();
    await target.put('backups/x.debk', sealBackup(Buffer.from('{}'), keyOf(11)));
    await expect(
      readBackup({ target, key: 'backups/x.debk', kek: keyOf(12), audit: { audit, actor: 'op' } }),
    ).rejects.toThrow(BackupError);
    expect(audit.events).toHaveLength(0);
  });

  it('gives the random bytes of a backup no use to a reader without the key', async () => {
    const target = new MemoryObjectStore();
    const kek = keyOf(13);
    await target.put('backups/r.debk', sealBackup(randomBytes(64), kek));
    const sealed = await target.get('backups/r.debk');
    expect(sealed).not.toBeNull();
    expect(() => openBackup(sealed!, keyOf(14))).toThrow(BackupError);
  });
});
