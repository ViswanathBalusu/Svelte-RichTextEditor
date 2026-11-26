/**
 * SEC-057 criteria 4 to 6 (10 section 4; 12 section 7), lane w8: what the documentation says, and what
 * a destroyed per-document key leaves in a backup.
 *
 * The purge of evidence and the legal hold are proved on PostgreSQL in
 * services/document-service/test/postgres/sec-057-purge-evidence.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DocumentKeyedObjectStore,
  sealExistingObjects,
} from '../../../services/document-service/src/objects/document-keyed-store.ts';
import {
  MemoryObjectStore,
  objectKeys,
} from '../../../services/document-service/src/objects/store.ts';
import {
  DocumentKeyDestroyedError,
  DocumentKeys,
  MemoryDocumentKeyStore,
} from '../../../services/document-service/src/storage/document-keys.ts';
import { MemoryKeyService } from '../../../services/document-service/src/storage/key-service.ts';

const GUIDE = readFileSync(
  new URL('../../../docs/operations/retention-and-backups.md', import.meta.url),
  'utf8',
);

describe('SEC-057 criteria 4 and 6: the operator documentation', () => {
  it('says that evidence follows the document and is deleted with it (criterion 4)', () => {
    const section = GUIDE.slice(GUIDE.indexOf('## Signing evidence'), GUIDE.indexOf('## Backups'));
    expect(section).toMatch(/no retention period of its own/);
    expect(section).toMatch(/kept as long as\s+the signed document exists/);
    expect(section).toMatch(/deleted with it/);
    expect(section).toMatch(/legal hold/);
  });

  it('says when purged data ages out of backups (criterion 6)', () => {
    const section = GUIDE.slice(GUIDE.indexOf('## Backups'));
    expect(section).toMatch(/purge acts on the live stores only/);
    expect(section).toMatch(/time of the purge plus the longest period/);
    expect(section).toMatch(/operator sets\s+them/);
  });
});

describe('SEC-057 criterion 5: a destroyed per-document key leaves nothing readable', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const DOC = '22222222-2222-4222-8222-222222222222';
  const ref = { tenant: TENANT, doc: DOC };
  const secret = 'the text of a sensitive checkpoint';

  it('the stored bytes and a backup copy hold no plaintext, and no read succeeds after destroy', async () => {
    const store = new MemoryDocumentKeyStore();
    const service = new MemoryKeyService();
    const raw = new MemoryObjectStore();
    const keys = new DocumentKeys({
      store,
      keys: service,
      headSeq: async () => 0,
      sealExisting: async (r, sealer) => {
        await sealExistingObjects(raw, r, sealer);
      },
      now: () => 1_700_000_000_000,
    });
    const objects = new DocumentKeyedObjectStore(raw, keys);
    await keys.setTenantOption(TENANT, true);
    await keys.provision(ref);
    const key = objectKeys.checkpoint(TENANT, DOC, 2);
    await objects.put(key, new TextEncoder().encode(secret));

    // The backup: the stored object and the key's row, copied before the key is destroyed.
    const backupObject = (await raw.get(key))!;
    const backupRow = (await store.get(ref))!;
    expect(new TextDecoder('latin1').decode(backupObject)).not.toContain(secret);
    expect(new TextDecoder().decode(await objects.get(key))).toBe(secret);

    await keys.destroy(ref);

    await expect(objects.get(key)).rejects.toBeInstanceOf(DocumentKeyDestroyedError);
    // The copy still has the wrapped data key, and the key service cannot unwrap it any more.
    await expect(service.unwrap(backupRow.keyId, backupRow.wrappedDek!)).rejects.toThrow();
    expect(new TextDecoder('latin1').decode((await raw.get(key))!)).not.toContain(secret);
  });
});
