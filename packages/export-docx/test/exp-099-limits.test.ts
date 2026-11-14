/**
 * EXP-099, criterion 2 (limits through the importer): a package that exceeds the entry-count,
 * total-size or compression-ratio limit is refused by `importDocx` itself, and the same package is
 * accepted under generous limits. The entry-count check runs on the central directory, before any
 * entry is inflated. Run in Node.js with vitest.
 */
import { describe, expect, it } from 'vitest';
import { importDocx, DEFAULT_ZIP_LIMITS, type ZipLimits } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const file = corpusFiles().find((f) => f.name === 'poi/sample.docx');

describe('EXP-099 criterion 2: entry, size and ratio limits through importDocx', () => {
  it('refuses a package with more entries than the entry limit', async () => {
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 };
    await expect(importDocx(readFile(file), { limits })).rejects.toThrow(
      /entries, more than the limit of 2/,
    );
  });

  it('refuses a package whose uncompressed total passes the size limit', async () => {
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, maxTotalSize: 1000 };
    await expect(importDocx(readFile(file), { limits })).rejects.toThrow(
      /uncompressed size exceeds the limit of 1000 bytes/,
    );
  });

  it('refuses a package whose compression ratio passes the ratio limit', async () => {
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, maxRatio: 1 };
    await expect(importDocx(readFile(file), { limits })).rejects.toThrow(
      /compression ratio above 1/,
    );
  });

  it('accepts the same package under the default limits', async () => {
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const imported = await importDocx(readFile(file));
    expect(imported.envelope).toBeDefined();
  });
});
