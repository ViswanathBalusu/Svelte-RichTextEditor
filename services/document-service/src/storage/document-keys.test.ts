// Per-document keys (HIS-041): the key service's destroy, the sealing of values and objects, and the
// refusals of the key rules. The PostgreSQL rows and the log store are in
// test/postgres/his-041-document-keys.pg.test.ts.
import { describe, expect, it } from 'vitest';
import { DocumentKeyedObjectStore, sealExistingObjects } from '../objects/document-keyed-store.ts';
import { MemoryObjectStore, objectKeys } from '../objects/store.ts';
import {
  DocumentKeyDestroyedError,
  DocumentKeyRefusedError,
  DocumentKeyUnavailableError,
  DocumentKeys,
  MemoryDocumentKeyStore,
  documentKeyId,
  isSealed,
} from './document-keys.ts';
import {
  KeyDestroyedError,
  KeyExistsError,
  MemoryKeyService,
  wrapDataKey,
  type KeyService,
} from './key-service.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ref = { tenant: TENANT, doc: DOC };
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('KeyService.destroy (HIS-041)', () => {
  it('makes what was wrapped with the key unwrappable by nobody, and keeps the identifier taken', async () => {
    const keys = new MemoryKeyService();
    await keys.create('document-x', 'unwrap');
    const wrapped = await wrapDataKey(
      await keys.publicJwk('document-x'),
      bytes('data key 32 bytes long........'),
    );
    expect(text(await keys.unwrap('document-x', wrapped))).toContain('data key');

    await keys.destroy('document-x');
    await expect(keys.unwrap('document-x', wrapped)).rejects.toBeInstanceOf(KeyDestroyedError);
    expect(await keys.enabled('document-x')).toBe(false);
    await expect(keys.create('document-x', 'unwrap')).rejects.toBeInstanceOf(KeyExistsError);
    // Destroying again is not an error, and another key is unaffected.
    await keys.destroy('document-x');
    await keys.create('document-y', 'unwrap');
    expect(await keys.enabled('document-y')).toBe(true);
  });
});

function setup(opts: { head?: number } = {}) {
  const store = new MemoryDocumentKeyStore();
  const service = new MemoryKeyService();
  let down = false;
  // A key service that can be made unreachable.
  const keys: KeyService = {
    create: (...a) => service.create(...a),
    publicJwk: (...a) => service.publicJwk(...a),
    sign: (...a) => service.sign(...a),
    unwrap: async (...a) => {
      if (down) throw new Error('the key service is unreachable');
      return service.unwrap(...a);
    },
    enabled: (...a) => service.enabled(...a),
    disable: (...a) => service.disable(...a),
    destroy: (...a) => service.destroy(...a),
  };
  const raw = new MemoryObjectStore();
  const documentKeys = new DocumentKeys({
    store,
    keys,
    headSeq: async () => opts.head ?? 0,
    sealExisting: async (r, sealer) => {
      await sealExistingObjects(raw, r, sealer);
    },
    now: () => 1_700_000_000_000,
  });
  const objects = new DocumentKeyedObjectStore(raw, documentKeys);
  return { store, service, documentKeys, raw, objects, setDown: (v: boolean) => (down = v) };
}

describe('DocumentKeys (HIS-041)', () => {
  it('refuses a key while the tenant option is off, and changes nothing (criterion 4)', async () => {
    const { documentKeys, store, objects, raw } = setup();
    await expect(documentKeys.provision(ref)).rejects.toMatchObject({ reason: 'option-off' });
    expect(await store.get(ref)).toBeNull();
    // Without a key a document's objects are stored and read as they are.
    const key = objectKeys.checkpoint(TENANT, DOC, 0);
    await objects.put(key, bytes('plain'));
    expect(text((await raw.get(key))!)).toBe('plain');
    expect(text((await objects.get(key))!)).toBe('plain');
  });

  it('gives a key only while the log is empty and only once', async () => {
    const used = setup({ head: 3 });
    await used.documentKeys.setTenantOption(TENANT, true);
    await expect(used.documentKeys.provision(ref)).rejects.toMatchObject({ reason: 'has-history' });

    const s = setup();
    await s.documentKeys.setTenantOption(TENANT, true);
    await s.documentKeys.provision(ref);
    await expect(s.documentKeys.provision(ref)).rejects.toBeInstanceOf(DocumentKeyRefusedError);
    await expect(s.documentKeys.provision(ref)).rejects.toMatchObject({ reason: 'has-key' });
    // A key row never holds the data key in the clear.
    const row = (await s.store.get(ref))!;
    expect(row.state).toBe('active');
    expect(row.keyId).toBe(documentKeyId(DOC));
    expect(row.wrappedDek!.byteLength).toBeGreaterThan(100);
  });

  it('seals what the document has already and what is written after, and opens it again (criterion 1)', async () => {
    const s = setup();
    await s.documentKeys.setTenantOption(TENANT, true);
    const seq0 = objectKeys.checkpoint(TENANT, DOC, 0);
    const other = objectKeys.checkpoint(TENANT, OTHER, 0);
    await s.raw.put(seq0, bytes('content at seq 0'));
    await s.raw.put(other, bytes('another document'));

    await s.documentKeys.provision(ref);
    expect(isSealed((await s.raw.get(seq0))!)).toBe(true);
    expect(text((await s.objects.get(seq0))!)).toBe('content at seq 0');
    // A document of the same tenant without a key is not touched.
    expect(text((await s.raw.get(other))!)).toBe('another document');

    // A checkpoint and a cold segment written afterwards are sealed, and each is bound to its key.
    const cp = objectKeys.checkpoint(TENANT, DOC, 2);
    const seg = objectKeys.segment(TENANT, DOC, 1, 2);
    await s.objects.put(cp, bytes('checkpoint two'));
    await s.objects.put(seg, bytes('segment payloads'));
    for (const k of [cp, seg]) {
      const stored = (await s.raw.get(k))!;
      expect(isSealed(stored)).toBe(true);
      expect(text(stored)).not.toContain('checkpoint two');
      expect(text(stored)).not.toContain('segment payloads');
    }
    expect(text((await s.objects.get(cp))!)).toBe('checkpoint two');
    expect(text((await s.objects.get(seg))!)).toBe('segment payloads');
    await s.raw.put(seg + '.copy', (await s.raw.get(seg))!);
    await expect(s.objects.get(seg + '.copy')).rejects.toThrow();
  });

  it('seals and opens a value, bound to its place', async () => {
    const s = setup();
    await s.documentKeys.setTenantOption(TENANT, true);
    await s.documentKeys.provision(ref);
    const sealer = (await s.documentKeys.sealerFor(ref))!;
    const sealed = await sealer.seal(`${DOC}/1`, bytes('payload one'));
    expect(isSealed(sealed)).toBe(true);
    expect(text(await sealer.open(`${DOC}/1`, sealed))).toBe('payload one');
    await expect(sealer.open(`${DOC}/2`, sealed)).rejects.toThrow();
    // Two seals of the same value differ (a fresh IV each time).
    expect(await sealer.seal(`${DOC}/1`, bytes('payload one'))).not.toEqual(sealed);
    // A value that is not sealed (history before the key) is returned as it is.
    expect(text(await sealer.open('x', bytes('plain value, longer than the header')))).toContain(
      'plain',
    );
  });

  it('is unavailable, not readable, while the key service is down (criterion 3)', async () => {
    const s = setup();
    await s.documentKeys.setTenantOption(TENANT, true);
    await s.documentKeys.provision(ref);
    const cp = objectKeys.checkpoint(TENANT, DOC, 2);
    await s.objects.put(cp, bytes('checkpoint two'));

    s.setDown(true);
    await expect(s.documentKeys.sealerFor(ref)).rejects.toBeInstanceOf(DocumentKeyUnavailableError);
    await expect(s.objects.get(cp)).rejects.toBeInstanceOf(DocumentKeyUnavailableError);
    // A write is refused too: it is never made in the clear.
    await expect(s.objects.put(cp, bytes('new'))).rejects.toBeInstanceOf(
      DocumentKeyUnavailableError,
    );
    expect(isSealed((await s.raw.get(cp))!)).toBe(true);

    s.setDown(false);
    expect(text((await s.objects.get(cp))!)).toBe('checkpoint two');
  });

  it('makes the document unreadable for good once the key is destroyed (criterion 2)', async () => {
    const s = setup();
    await s.documentKeys.setTenantOption(TENANT, true);
    await s.documentKeys.provision(ref);
    const cp = objectKeys.checkpoint(TENANT, DOC, 2);
    await s.objects.put(cp, bytes('checkpoint two'));
    const backup = {
      object: (await s.raw.get(cp))!,
      row: (await s.store.get(ref))!,
    };

    await s.documentKeys.destroy(ref);
    await expect(s.documentKeys.sealerFor(ref)).rejects.toBeInstanceOf(DocumentKeyDestroyedError);
    await expect(s.objects.get(cp)).rejects.toBeInstanceOf(DocumentKeyDestroyedError);
    const row = (await s.store.get(ref))!;
    expect(row.state).toBe('destroyed');
    expect(row.wrappedDek).toBeNull();
    // The copy taken before still has the wrapped data key, and the key service cannot unwrap it.
    await expect(s.service.unwrap(backup.row.keyId, backup.row.wrappedDek!)).rejects.toBeInstanceOf(
      KeyDestroyedError,
    );
    expect(isSealed(backup.object)).toBe(true);
    // Destroying twice is allowed; a new key for the same document is not.
    await s.documentKeys.destroy(ref);
    await expect(s.documentKeys.provision(ref)).rejects.toMatchObject({ reason: 'has-key' });
    await expect(s.documentKeys.destroy({ tenant: TENANT, doc: OTHER })).rejects.toMatchObject({
      reason: 'no-key',
    });
  });
});
