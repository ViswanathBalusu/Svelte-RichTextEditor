/**
 * EXP-099, criterion 2 (second half): a central directory and local header that declare a small
 * uncompressed size, over an entry that inflates to more, are refused while the entry is being
 * inflated, not after it has been expanded in full.
 */
import { describe, expect, it } from 'vitest';
import { entryData, readZip, writeZip, ZipError } from '../src/index.ts';

/** Overwrites the declared uncompressed size (LE u32) in the local and central headers of `name`. */
function declareSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const nameBytes = new TextEncoder().encode(name);
  const find = (sig: number, lenOffset: number, nameOffset: number, sizeOffset: number): void => {
    for (let i = 0; i + 46 <= out.length; i++) {
      if (view.getUint32(i, true) !== sig) continue;
      const n = view.getUint16(i + lenOffset, true);
      if (n !== nameBytes.length) continue;
      if (nameBytes.every((b, k) => out[i + nameOffset + k] === b))
        view.setUint32(i + sizeOffset, size, true);
    }
  };
  find(0x04034b50, 26, 30, 22);
  find(0x02014b50, 28, 46, 24);
  return out;
}

describe('EXP-099: bounded inflate', () => {
  it('refuses an entry that inflates past its declared size, before it is expanded in full', () => {
    // Incompressible bytes, so the ratio check does not trip before the inflate bound does.
    const big = new Uint8Array(256 * 1024);
    let seed = 1;
    for (let i = 0; i < big.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      big[i] = seed & 0xff;
    }
    const zip = writeZip([{ name: 'word/document.xml', data: big }]);
    const lying = declareSize(zip, 'word/document.xml', 1000);
    const archive = readZip(lying);
    const entry = archive.byName.get('word/document.xml')!;
    expect(entry.size).toBe(1000);
    expect(() => entryData(archive, entry)).toThrow(ZipError);
    expect(() => entryData(archive, entry)).toThrow(/more than its declared 1000 bytes/);
  });

  it('still reads an honest entry, and its bytes and CRC match', () => {
    const data = new TextEncoder().encode('<w:document>' + 'x'.repeat(200_000) + '</w:document>');
    const archive = readZip(writeZip([{ name: 'word/document.xml', data }]));
    expect(entryData(archive, archive.byName.get('word/document.xml')!)).toEqual(data);
  });
});
