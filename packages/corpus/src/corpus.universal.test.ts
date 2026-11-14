/**
 * The corpus is the same in every runtime (FND-006): the documents and images built here, in
 * Node.js or in a browser engine, have the bytes and canonical hashes that the manifest recorded
 * when Node.js generated it.
 */
import { describe, expect, it } from 'vitest';
import { sha256HexBytes, utf8 } from '@docedit/model';
import { corpusImages } from './generate/index.ts';
import { loadDocument, manifest, serializeDocument } from './index.ts';

describe('the corpus in this runtime', () => {
  it.each(manifest.documents.filter((d) => d.inRepository).map((d) => d.name))(
    'builds %s with the canonical hash and file bytes of the manifest',
    async (name) => {
      const doc = await loadDocument(name);
      expect(await sha256HexBytes(utf8(serializeDocument(doc.envelope)))).toBe(
        doc.entry.fileSha256,
      );
    },
  );

  it('draws every image with the bytes of the manifest', async () => {
    for (const image of corpusImages()) {
      const entry = manifest.assets.find((a) => a.id === image.id);
      expect(await sha256HexBytes(image.bytes)).toBe(entry?.sha256);
    }
  });
});
