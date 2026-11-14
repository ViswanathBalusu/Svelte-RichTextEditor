/**
 * EXP-099, criterion 6: an embedded object is opaque to the importer. It becomes a preserved atom
 * whose fragment holds the embedding part byte for byte; the importer does not parse the object.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { entryData, importDocx, readFragment, readZip } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const findAtoms = (n: JsonNode, label: string, out: JsonNode[] = []): JsonNode[] => {
  if (n.type.startsWith('preserved') && n.attrs?.['label'] === label) out.push(n);
  for (const c of n.content ?? []) findAtoms(c, label, out);
  return out;
};

describe('EXP-099: embedded objects are opaque', () => {
  it('keeps the embedding part byte for byte in the atom fragment, without parsing it', async () => {
    const bytes = readFile(corpusFiles().find((x) => x.name === 'poi/EmbeddedDocument.docx')!);
    const imported = await importDocx(bytes);
    const atoms = findAtoms(imported.envelope.doc, 'embedded object');
    expect(atoms.length).toBeGreaterThan(0);
    const source = readZip(bytes);
    for (const atom of atoms) {
      const id = String(atom.attrs?.['fragment']);
      const asset = imported.assets.get(id);
      expect(asset?.role).toBe('fragment');
      const fragment = readFragment(asset!.bytes);
      const embedding = fragment.meta.parts.find((p) => p.name.startsWith('word/embeddings/'));
      expect(embedding, 'the embedding part is carried by the fragment').toBeDefined();
      const inFragment = readZip(asset!.bytes).byName.get(`parts/${embedding!.name}`);
      const original = source.byName.get(embedding!.name);
      expect(inFragment && original).toBeTruthy();
      expect(entryData(readZip(asset!.bytes), inFragment!)).toEqual(entryData(source, original!));
    }
  });
});
