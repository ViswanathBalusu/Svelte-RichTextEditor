/**
 * SEC-049 (10 §3.7; 06 §13; BE-096), lane V-SEC-049-064, Node.js, no services running: a backup of
 * a scenario with canary strings in its database dump and in a tenant's object is searched in its
 * raw bytes; a backup is refused without its key; every write, read and copy is audited with the
 * actor; and the backup key is not one of the live keys. The PostgreSQL and S3-compatible run of
 * the same module is services/document-service/test/data-plane/be-096-backup.pg.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../../services/document-service/src/data-plane/memory-ports.ts';
import {
  BackupError,
  backupKey,
  copyBackup,
  openBackup,
  readBackup,
  writeBackup,
  type BackupBundle,
} from '../../../services/document-service/src/data-plane/backup.ts';
import {
  EncryptedObjectStore,
  tenantKeyId,
} from '../../../services/document-service/src/objects/encrypted-store.ts';
import { MemoryObjectStore } from '../../../services/document-service/src/objects/store.ts';
import { MemoryKeyService } from '../../../services/document-service/src/storage/key-service.ts';

const CANARY_TEXT = 'CANARY_SEC_049_TEXT_5d8a';
const CANARY_OBJECT = 'CANARY_SEC_049_OBJECT_0c7e';
const CANARY_NAME = 'CANARY_SEC_049_NAME_9f21';
const DUMP = `CREATE TABLE doc_commits (seq integer);\nCOPY audit_events (note) FROM stdin;\n${CANARY_NAME}\n\\.\n`;

function keyOf(): ReturnType<typeof backupKey> {
  return backupKey(randomBytes(32).toString('base64'));
}

describe('SEC-049 criterion 1: the raw backup files hold no canary in clear', () => {
  it('a database dump and a tenant object with canaries are sealed, and the canaries open only with the key', async () => {
    const tenant = randomUUID();
    const keys = new MemoryKeyService();
    const raw = new MemoryObjectStore();
    const encrypted = new EncryptedObjectStore(raw, keys);
    await encrypted.provision(tenant);
    const objectKey = `tenants/${tenant}/checkpoints/0.json`;
    const plainObject = Buffer.from(JSON.stringify({ text: CANARY_OBJECT }));
    await encrypted.put(objectKey, plainObject);

    // Positive controls: the canaries are in the scenario, and the encrypted store reads them back.
    expect(DUMP.includes(CANARY_NAME)).toBe(true);
    expect(
      Buffer.from((await encrypted.get(objectKey))!).includes(Buffer.from(CANARY_OBJECT)),
    ).toBe(true);
    // The object as stored is sealed under the tenant key, so the canary is not in clear there.
    expect(Buffer.from((await raw.get(objectKey))!).includes(Buffer.from(CANARY_OBJECT))).toBe(
      false,
    );

    const kek = keyOf();
    const target = new MemoryObjectStore();
    const audit = new MemoryAudit();
    const receipt = await writeBackup({
      source: { dumpDatabase: async () => new TextEncoder().encode(DUMP), objects: raw },
      tenants: [tenant],
      kek,
      target,
      targetKey: 'backups/sec-049-1.debk',
      audit: { audit, actor: 'operator:sec-049' },
    });
    expect(receipt.objects).toBe(1);

    const sealed = Buffer.from((await target.get('backups/sec-049-1.debk'))!);
    for (const canary of [CANARY_TEXT, CANARY_OBJECT, CANARY_NAME]) {
      expect(sealed.includes(Buffer.from(canary)), canary).toBe(false);
    }
    expect(sealed.includes(Buffer.from('CREATE TABLE'))).toBe(false);

    // With its own key the backup opens and the canaries are in it (the copy is complete).
    const bundle: BackupBundle = await readBackup({
      target,
      key: 'backups/sec-049-1.debk',
      kek,
      audit: { audit, actor: 'operator:sec-049' },
    });
    expect(Buffer.from(bundle.database, 'base64').toString('utf8')).toBe(DUMP);
    expect(
      Buffer.from(bundle.objects[0]!.data, 'base64').equals(
        Buffer.from((await raw.get(objectKey)) as Uint8Array),
      ),
    ).toBe(true);
  });
});

describe('SEC-049 criterion 2: a backup is not restored without its key', () => {
  it('refuses to open a backup with another key, and a changed body is refused under the right key', async () => {
    const kek = keyOf();
    const target = new MemoryObjectStore();
    const audit = new MemoryAudit();
    await writeBackup({
      source: {
        dumpDatabase: async () => new TextEncoder().encode(DUMP),
        objects: new MemoryObjectStore(),
      },
      tenants: [randomUUID()],
      kek,
      target,
      targetKey: 'backups/sec-049-2.debk',
      audit: { audit, actor: 'operator:sec-049' },
    });
    const sealed = Buffer.from((await target.get('backups/sec-049-2.debk'))!);

    await expect(
      readBackup({
        target,
        key: 'backups/sec-049-2.debk',
        kek: keyOf(),
        audit: { audit, actor: 'operator:sec-049' },
      }),
    ).rejects.toThrow(BackupError);
    expect(() => openBackup(sealed, keyOf())).toThrow(BackupError);

    const altered = Buffer.from(sealed);
    altered[altered.length - 1]! ^= 0x01;
    expect(() => openBackup(altered, kek)).toThrow(/damaged/);
  });
});

describe('SEC-049 criterion 3: each read, write and copy is audited with the actor', () => {
  it('records written, read and copied per tenant, with the actor and no content', async () => {
    const tenant = randomUUID();
    const kek = keyOf();
    const target = new MemoryObjectStore();
    const audit = new MemoryAudit();
    const actor = 'operator:sec-049-audit';

    await writeBackup({
      source: {
        dumpDatabase: async () => new TextEncoder().encode(DUMP),
        objects: new MemoryObjectStore(),
      },
      tenants: [tenant],
      kek,
      target,
      targetKey: 'backups/sec-049-3.debk',
      audit: { audit, actor },
    });
    await readBackup({ target, key: 'backups/sec-049-3.debk', kek, audit: { audit, actor } });
    await copyBackup({
      target,
      from: 'backups/sec-049-3.debk',
      to: 'backups/sec-049-3-copy.debk',
      kek,
      audit: { audit, actor },
    });

    const events = await audit.query(tenant, { limit: 100 });
    expect(events.map((e) => e.kind)).toEqual(['backup.written', 'backup.read', 'backup.copied']);
    for (const e of events) {
      expect(e.actor).toBe(actor);
      expect(JSON.stringify(e)).not.toContain(CANARY_NAME);
    }
  });
});

// Identifiers only: the proof by key material and behaviour is sec-049-backup-keys.test.ts.
describe('SEC-049 criterion 4: the backup key is apart from the live keys', () => {
  it('has an identifier of its own, not a tenant key identifier, and no live key of the key service', async () => {
    const tenants = [randomUUID(), randomUUID()];
    const keys = new MemoryKeyService();
    for (const t of tenants) {
      await new EncryptedObjectStore(new MemoryObjectStore(), keys).provision(t);
    }
    const kek = keyOf();
    const liveIds = new Set<string>(tenants.map((t) => tenantKeyId(t)));
    for (const t of tenants) {
      expect(await keys.enabled(tenantKeyId(t))).toBe(true);
    }
    expect(kek.id).toMatch(/^backup-[0-9a-f]{16}$/);
    expect(liveIds.has(kek.id)).toBe(false);
    for (const t of tenants) expect(kek.id).not.toBe(tenantKeyId(t));
    // A key of the same bytes gives the same identifier, so it is a fingerprint and not a random name.
    expect(backupKey(kek.key.toString('base64')).id).toBe(kek.id);
  });
});
