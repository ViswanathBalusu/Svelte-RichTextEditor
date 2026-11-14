/**
 * EXP-108, criterion 1 over the whole corpus: the original file is stored as a content-addressed,
 * immutable asset of the import, and the document is attached to it (the validator accepts the
 * document with the import's asset set attached). The asset is server-only (SR-C1).
 *
 * Not covered here: the download (criterion 2), the retention job and the purge (criterion 3), and
 * the import version that names the asset (criterion 4, which needs EXP-098). The production object
 * store is BE-003; these tests cover the package's in-memory store only.
 */
import { describe, expect, it } from 'vitest';
import { sha256HexBytes } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { AssetStore, importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe.each(corpusFiles())('$name', (file) => {
  it('stores the original package as a server-only, content-addressed asset', async () => {
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const original = imported.assets.get(imported.originalAsset);
    expect(original, 'the import names an original asset that the store holds').toBeDefined();
    expect(original!.role).toBe('original');
    expect(original!.serverOnly).toBe(true);
    expect(original!.contentType).toBe(DOCX);
    // Content-addressed: the recorded digest is the digest of the bytes stored, and those bytes
    // are the file the import read, unchanged.
    expect(original!.sha256).toBe(await sha256HexBytes(bytes));
    expect(original!.bytes).not.toBe(bytes);
    expect(original!.bytes).toEqual(bytes);
  });

  it('keeps the original immutable: changing the input or a read copy leaves the asset as it was', async () => {
    const bytes = readFile(file);
    const pristine = bytes.slice();
    const digest = await sha256HexBytes(pristine);
    const imported = await importDocx(bytes);
    const original = imported.assets.get(imported.originalAsset)!;
    // The caller changes its own buffer after the import: the stored asset does not follow.
    bytes[0] = bytes[0]! ^ 0xff;
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    expect(original.bytes).toEqual(pristine);
    expect(await sha256HexBytes(original.bytes)).toBe(digest);
    expect(original.sha256).toBe(digest);
    // A reader changes the bytes it was given: the next read still gives the original.
    const read = original.bytes;
    read.fill(0);
    expect(original.bytes).toEqual(pristine);
    expect(imported.assets.get(imported.originalAsset)!.bytes).toEqual(pristine);
    // The asset itself cannot be changed or replaced.
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => {
      (original as { sha256: string }).sha256 = '0'.repeat(64);
    }).toThrow(TypeError);
    expect(() => {
      (original as { bytes: Uint8Array }).bytes = new Uint8Array();
    }).toThrow(TypeError);
    expect(original.sha256).toBe(digest);
    expect(original.bytes).toEqual(pristine);
  });

  it('attaches the original to the document: the validator accepts it with the asset set', async () => {
    const imported = await importDocx(readFile(file));
    expect(imported.assets.ids().has(imported.originalAsset)).toBe(true);
    const result = validate(imported.envelope, { attachedAssets: imported.assets.ids() });
    expect(result.violations).toEqual([]);
  });
});

describe('the asset store', () => {
  it('gives equal bytes of one role the same asset, and keeps the first bytes', async () => {
    const store = new AssetStore();
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);
    const a = await store.add(bytes, DOCX, 'original');
    const b = await store.add(new Uint8Array(bytes), DOCX, 'original');
    expect(b).toBe(a);
    expect(store.ids().size).toBe(1);
    expect(store.get(a)!.sha256).toBe(await sha256HexBytes(bytes));
    expect(store.get(a)!.bytes).toEqual(bytes);
  });

  it('copies the bytes on add, so the caller cannot change a stored asset', async () => {
    const store = new AssetStore();
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);
    const digest = await sha256HexBytes(bytes);
    const id = await store.add(bytes, DOCX, 'original');
    bytes[4] = 99;
    expect(store.get(id)!.bytes).toEqual(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]));
    expect(store.get(id)!.sha256).toBe(digest);
    expect(store.totalBytes('original')).toBe(7);
    // The changed buffer is other content: it is another asset, and the first is untouched.
    const other = await store.add(bytes, DOCX, 'original');
    expect(other).not.toBe(id);
    expect(store.get(id)!.sha256).toBe(digest);
    // The store exposes no map that a caller could change.
    expect('byId' in store).toBe(false);
  });

  it('gives different bytes different assets, and equal bytes of another role another asset', async () => {
    const store = new AssetStore();
    const x = await store.add(new Uint8Array([1, 2, 3]), DOCX, 'original');
    const y = await store.add(new Uint8Array([1, 2, 4]), DOCX, 'original');
    const z = await store.add(new Uint8Array([1, 2, 3]), 'application/octet-stream', 'fragment');
    expect(new Set([x, y, z]).size).toBe(3);
    expect(store.get(z)!.serverOnly).toBe(true);
  });

  it('gives the original of two imports of one file the same digest', async () => {
    const bytes = readFile(corpusFiles()[0]!);
    const a = await importDocx(bytes);
    const b = await importDocx(bytes);
    expect(a.assets.get(a.originalAsset)!.sha256).toBe(b.assets.get(b.originalAsset)!.sha256);
  });
});
