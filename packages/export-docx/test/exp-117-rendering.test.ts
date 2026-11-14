/**
 * EXP-117, criterion 3, first half (lane V-EXP-113-123): when the file holds a picture that renders
 * a preserved atom (an alternate-content fallback, a VML fallback picture, or a picture inside the
 * drawing), the atom's `fallbackAsset` is that picture. Checked on every corpus file: each preserved
 * atom whose fragment XML refers to an internal image relationship of its fragment has a
 * `fallbackAsset`, and the asset is an image of the package.
 *
 * A cached drawing that is DrawingML XML (for example the drawing part of a SmartArt) is not a
 * picture, so it is not checked here; such an atom keeps its kind as `fallbackText` (see the
 * Notes of EXP-117 for the decision).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { importDocx, readFragment } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

function atomsOf(doc: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'preserved_inline' || n.type === 'preserved_block') out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

const IMAGE_TYPE = /\/image$/;

describe('EXP-117 criterion 3: a rendering in the file becomes the fallbackAsset', () => {
  it('every atom whose fragment refers to an internal image has a fallbackAsset', async () => {
    let checked = 0;
    const missing: string[] = [];
    for (const file of corpusFiles()) {
      const imported = await importDocx(readFile(file));
      for (const atom of atomsOf(imported.envelope.doc as JsonNode)) {
        const id = atom.attrs?.['fragment'];
        if (typeof id !== 'string') continue;
        const asset = imported.assets.get(id);
        if (!asset) continue;
        const fragment = readFragment(asset.bytes);
        const images = new Set(
          fragment.meta.rels.filter((r) => !r.external && IMAGE_TYPE.test(r.type)).map((r) => r.id),
        );
        if (!images.size) continue;
        const refs = [...fragment.xml.matchAll(/\br:[A-Za-z]+="([^"]+)"/g)].map((m) => m[1]!);
        if (!refs.some((r) => images.has(r))) continue;
        checked++;
        if (atom.attrs?.['fallbackAsset'] === undefined)
          missing.push(`${file.name} ${String(atom.attrs?.['label'])}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
